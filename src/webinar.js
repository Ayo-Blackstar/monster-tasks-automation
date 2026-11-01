// src/routes/webinar.js
// Monster Tasks — Webinar registrations → Discord new-leads channel (with UTM attribution)
//
// Called by the GHL workflow "[Webinar] MT Registration" (Webhook action, POST):
//   https://monster-tasks-automation-production.up.railway.app/webinar/registration
//
// Send these as Custom Data from the GHL Webhook action (any you leave out are skipped):
//   contact_id, first_name, last_name, full_name, email, phone, company, webinar
//   utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, fbclid, gclid
// Any other key you add is also shown in the notification.
//
// Railway env vars used: DISCORD_WEBHOOK_NEW_LEADS, GHL_LOCATION_ID

const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');

const recent = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

function isDuplicate(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of recent.entries()) {
    if (now - t > DEDUP_WINDOW_MS) recent.delete(k);
  }
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

const CONTACT_KEYS = ['contact_id', 'contactid', 'first_name', 'last_name', 'full_name', 'name', 'email', 'phone', 'company', 'company_name', 'webinar', 'webinar_name'];
const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'fbclid', 'gclid'];

// GHL sends "{{...}}" literally, or an empty string, when a merge field has no value
function clean(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (!s || /^\{\{.*\}\}$/.test(s) || s === 'null' || s === 'undefined') return '';
  return s;
}

function buildFields(body) {
  const b = {};
  for (const [k, v] of Object.entries(body || {})) {
    const c = clean(v);
    if (c) b[k.toLowerCase()] = c;
  }

  const contactId = b.contact_id || b.contactid || '';
  const name = b.full_name || b.name || `${b.first_name || ''} ${b.last_name || ''}`.trim() || b.email || 'Unknown';
  const nameValue = contactId
    ? `[${name}](https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/${contactId})`
    : name;

  const fields = [
    { name: 'Time', value: new Date().toLocaleDateString('en-GB'), inline: true },
    { name: 'Contact', value: nameValue, inline: true },
  ];
  if (b.webinar || b.webinar_name) fields.push({ name: 'Webinar', value: b.webinar || b.webinar_name, inline: true });
  if (b.email) fields.push({ name: 'Email', value: b.email, inline: true });
  if (b.phone) fields.push({ name: 'Phone', value: b.phone, inline: true });
  if (b.company || b.company_name) fields.push({ name: 'Company', value: b.company || b.company_name, inline: true });

  // Any extra answers the workflow sends
  for (const [k, v] of Object.entries(b)) {
    if (CONTACT_KEYS.includes(k) || ATTRIBUTION_KEYS.includes(k) || k.startsWith('utm_')) continue;
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    fields.push({ name: label.slice(0, 256), value: v.slice(0, 1024), inline: true });
  }

  // UTM attribution, same format as the Typeform notifications
  const utmLines = Object.entries(b)
    .filter(([k]) => ATTRIBUTION_KEYS.includes(k) || k.startsWith('utm_'))
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n');
  fields.push({ name: 'ATTRIBUTION', value: utmLines || 'No UTM data', inline: false });

  return { fields: fields.slice(0, 25), email: b.email, contactId };
}

router.post('/registration', async (req, res) => {
  try {
    const { fields, email, contactId } = buildFields(req.body);

    if (isDuplicate(email || contactId)) {
      console.log('[webinar] Duplicate registration skipped:', email || contactId);
      return res.json({ success: true, skipped: 'duplicate' });
    }

    const embed = createEmbed('🎥 New Webinar Registration', fields, COLORS.BLUE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NEW_LEADS, embed);
    console.log('[webinar] Registration posted:', email || contactId);
    res.json({ success: true });
  } catch (err) {
    console.error('[webinar] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = { buildFields, clean };
