// src/routes/facebook.js
// Monster Tasks — Facebook Lead Ads → GHL (upsert) + Discord new-leads notification
//
// Mount in index.js BEFORE app.use(express.json()):
//   app.use(require('./routes/facebook'));
//
// Railway env vars required:
//   META_VERIFY_TOKEN          any random string (also entered in Meta webhook setup)
//   META_APP_SECRET            Meta app secret (used to verify webhook signatures)
//   META_PAGE_ACCESS_TOKEN     long-lived Page access token for the Monster Task page
//   META_GRAPH_VERSION         optional, default v23.0
//   META_REVENUE_KEYWORD       optional, default "revenue" (matches the revenue question name)
//   GHL_API_KEY                GHL private integration token (same one the other routes use)
//   GHL_LOCATION_ID            qr9qjJV7Act80CLSCzhu
//   GHL_FIELD_MONTHLY_REVENUE  GaQiLwtPxc6njW9rTCon (same field typeform.js writes to)
//   DISCORD_WEBHOOK_NEW_LEADS  Discord new-leads channel webhook

const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const REVENUE_KEYWORD = (process.env.META_REVENUE_KEYWORD || 'revenue').toLowerCase();

const COLORS = { GOLD: 0xf1c40f, GREEN: 0x2ecc71, BLUE: 0x3498db };

// Meta retries deliveries, so remember recent lead IDs to avoid duplicates
const seenLeads = new Set();
function markSeen(id) {
  seenLeads.add(id);
  if (seenLeads.size > 1000) seenLeads.delete(seenLeads.values().next().value);
}

// ---------- Webhook verification (Meta calls this once when you save the callback URL)
router.get('/facebook/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[facebook] Webhook verified');
    return res.status(200).send(challenge);
  }
  console.warn('[facebook] Webhook verification failed');
  return res.sendStatus(403);
});

// ---------- Lead delivery
router.post('/facebook/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  if (!validSignature(raw, req.get('x-hub-signature-256'))) {
    console.warn('[facebook] Invalid signature — request ignored');
    return res.sendStatus(401);
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    console.error('[facebook] Could not parse payload');
    return res.sendStatus(400);
  }

  // Reply to Meta immediately, process after
  res.sendStatus(200);

  const events = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen' && change.value && change.value.leadgen_id) {
        events.push(change.value);
      }
    }
  }

  events.forEach((ev) => {
    handleLead(ev).catch((err) => console.error('[facebook] Lead failed:', ev.leadgen_id, err.message));
  });
});

function validSignature(raw, header) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.warn('[facebook] META_APP_SECRET not set — skipping signature check');
    return true;
  }
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Main handler
async function handleLead(ev) {
  const leadId = ev.leadgen_id;
  if (seenLeads.has(leadId)) {
    console.log('[facebook] Duplicate delivery skipped:', leadId);
    return;
  }
  markSeen(leadId);

  const lead = await graphGet(`${leadId}`, 'field_data,created_time,form_id,ad_name,adset_name,campaign_name');
  const answers = flattenFieldData(lead.field_data || []);

  let formName = '';
  const formId = lead.form_id || ev.form_id;
  if (formId) {
    try {
      const form = await graphGet(`${formId}`, 'name');
      formName = form.name || '';
    } catch (e) {
      console.warn('[facebook] Could not fetch form name:', e.message);
    }
  }

  const contact = extractContact(answers);
  const revenue = findRevenue(answers);
  const tier = getTier(revenue);

  console.log(`[facebook] Lead ${leadId} — ${contact.fullName || contact.email} — revenue: ${revenue || 'n/a'} — ${tier}`);

  let ghlContactId = null;
  try {
    ghlContactId = await upsertGhlContact(contact, revenue, tier, formName);
  } catch (e) {
    console.error('[facebook] GHL upsert failed:', e.message);
  }

  await sendDiscord({ contact, answers, revenue, tier, formName, lead, ghlContactId });
}

// ---------- Meta Graph API
async function graphGet(path, fields) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(process.env.META_PAGE_ACCESS_TOKEN)}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(`Graph ${path}: ${data.error ? data.error.message : r.status}`);
  }
  return data;
}

function flattenFieldData(fieldData) {
  return fieldData.map((f) => ({
    name: f.name,
    label: prettify(f.name),
    value: Array.isArray(f.values) ? f.values.join(', ') : String(f.values || ''),
  }));
}

function prettify(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/\?$/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pick(answers, keys) {
  const hit = answers.find((a) => keys.includes(a.name.toLowerCase()));
  return hit ? hit.value.trim() : '';
}

function extractContact(answers) {
  let firstName = pick(answers, ['first_name']);
  let lastName = pick(answers, ['last_name']);
  const fullName = pick(answers, ['full_name', 'name']) || `${firstName} ${lastName}`.trim();

  if (!firstName && fullName) {
    const parts = fullName.split(' ');
    firstName = parts.shift();
    lastName = parts.join(' ');
  }

  return {
    firstName,
    lastName,
    fullName,
    email: pick(answers, ['email', 'work_email']),
    phone: pick(answers, ['phone_number', 'phone', 'work_phone_number']),
    company: pick(answers, ['company_name', 'company']),
  };
}

const STANDARD_FIELDS = [
  'first_name', 'last_name', 'full_name', 'name', 'email', 'work_email',
  'phone_number', 'phone', 'work_phone_number',
];

function findRevenue(answers) {
  const hit = answers.find((a) => a.name.toLowerCase().includes(REVENUE_KEYWORD));
  return hit ? hit.value.trim() : '';
}

// Gold $50k+, Green $10k–$50k, Blue below $10k
function getTier(revenueText) {
  if (!revenueText) return 'BLUE';
  const t = revenueText.toLowerCase().replace(/,/g, '');

  if (/(under|less than|below|<)/.test(t)) {
    const n = parseAmount(t);
    if (n !== null && n > 50000) return 'GREEN';
    return 'BLUE';
  }

  const n = parseAmount(t); // first number = lower bound of a range
  if (n === null) return 'BLUE';
  if (n >= 50000) return 'GOLD';
  if (n >= 10000) return 'GREEN';
  return 'BLUE';
}

function parseAmount(t) {
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === 'k' || unit === 'thousand') n *= 1000;
  if (unit === 'm' || unit === 'million') n *= 1000000;
  return n;
}

// ---------- GHL
async function upsertGhlContact(contact, revenue, tier, formName) {
  if (!contact.email && !contact.phone) {
    console.warn('[facebook] No email or phone — skipping GHL upsert');
    return null;
  }

  const body = {
    locationId: process.env.GHL_LOCATION_ID,
    firstName: contact.firstName || undefined,
    lastName: contact.lastName || undefined,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
    companyName: contact.company || undefined,
    source: formName ? `Facebook Lead Form - ${formName}` : 'Facebook Lead Form',
    tags: ['facebook-lead', `fb-${tier.toLowerCase()}`],
  };

  if (revenue && process.env.GHL_FIELD_MONTHLY_REVENUE) {
    body.customFields = [{ id: process.env.GHL_FIELD_MONTHLY_REVENUE, value: revenue }];
  }

  const r = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GHL ${r.status}: ${JSON.stringify(data)}`);

  const id = (data.contact && data.contact.id) || data.id || null;
  console.log(`[facebook] GHL contact ${data.new ? 'created' : 'updated'}: ${id}`);
  return id;
}

// ---------- Discord
async function sendDiscord({ contact, answers, revenue, tier, formName, lead, ghlContactId }) {
  const webhook = process.env.DISCORD_WEBHOOK_NEW_LEADS;
  if (!webhook) {
    console.warn('[facebook] DISCORD_WEBHOOK_NEW_LEADS not set');
    return;
  }

  const tierLabel = { GOLD: '🥇 GOLD', GREEN: '🟢 GREEN', BLUE: '🔵 BLUE' }[tier];

  const fields = [
    { name: 'Name', value: contact.fullName || '—', inline: true },
    { name: 'Email', value: contact.email || '—', inline: true },
    { name: 'Phone', value: contact.phone || '—', inline: true },
    { name: 'Monthly Revenue', value: revenue || 'Not answered', inline: true },
    { name: 'Tier', value: tierLabel, inline: true },
  ];

  const extra = answers.filter(
    (a) => !STANDARD_FIELDS.includes(a.name.toLowerCase()) && !a.name.toLowerCase().includes(REVENUE_KEYWORD)
  );
  extra.forEach((a) => {
    fields.push({ name: a.label.slice(0, 256), value: (a.value || '—').slice(0, 1024), inline: false });
  });

  if (formName) fields.push({ name: 'Form', value: formName, inline: true });
  if (lead.campaign_name) fields.push({ name: 'Campaign', value: lead.campaign_name, inline: true });
  if (lead.ad_name) fields.push({ name: 'Ad', value: lead.ad_name, inline: true });

  if (ghlContactId) {
    fields.push({
      name: 'GHL Contact',
      value: `[Open in GHL](https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/${ghlContactId})`,
      inline: false,
    });
  }

  const payload = {
    embeds: [
      {
        title: '📥 New Lead — Facebook Lead Form',
        color: COLORS[tier],
        fields: fields.slice(0, 25),
        timestamp: lead.created_time ? new Date(lead.created_time).toISOString() : new Date().toISOString(),
      },
    ],
  };

  const r = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('[facebook] Discord error:', r.status, await r.text());
  else console.log('[facebook] Discord notification sent');
}

module.exports = router;
module.exports._test = { getTier, extractContact, findRevenue };
