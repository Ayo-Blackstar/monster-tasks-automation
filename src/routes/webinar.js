// src/routes/webinar.js
// Monster Tasks — Webinar registrations → Discord new-leads channel
// Shows ONLY: name (linked to GHL), email, phone, webinar, and the UTMs.
//
// Called by the GHL workflow "[Webinar] MT Registration" (Webhook action, POST):
//   https://monster-tasks-automation-production.up.railway.app/webinar/registration
//
// UTMs are read from (first one that has a value wins):
//   1. Custom Data on the GHL Webhook action (utm_source, utm_medium, ...) → arrives in body.customData
//   2. Top-level keys (utm_source, ...)
//   3. GHL's own attribution on the contact (attributionSource / lastAttributionSource)
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

// GHL sends "{{...}}" literally, or an empty string, when a merge field has no value
function clean(v) {
  if (v === undefined || v === null || typeof v === 'object') return '';
  const s = String(v).trim();
  if (!s || /^\{\{.*\}\}$/.test(s) || s === 'null' || s === 'undefined') return '';
  return s;
}

function firstValue(...vals) {
  for (const v of vals) {
    const c = clean(v);
    if (c) return c;
  }
  return '';
}

// Each UTM: snake_case key (custom data) + camelCase key (GHL attribution)
const UTMS = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_term', 'utmTerm'],
];

function buildFields(body = {}) {
  const custom = (body.customData && typeof body.customData === 'object') ? body.customData : {};
  const contactObj = (body.contact && typeof body.contact === 'object') ? body.contact : {};
  const attrSources = [
    body.attributionSource,
    contactObj.attributionSource,
    body.lastAttributionSource,
    contactObj.lastAttributionSource,
  ].filter((a) => a && typeof a === 'object');

  const contactId = firstValue(custom.contact_id, body.contact_id, contactObj.id);
  const firstName = firstValue(custom.first_name, body.first_name);
  const lastName = firstValue(custom.last_name, body.last_name);
  const fullName = firstValue(custom.full_name, body.full_name, `${firstName} ${lastName}`.trim());
  const email = firstValue(custom.email, body.email);
  const phone = firstValue(custom.phone, body.phone);
  const webinar = firstValue(custom.webinar, body.webinar);

  const name = fullName || email || 'Unknown';
  const nameValue = contactId
    ? `[${name}](https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/${contactId})`
    : name;

  const fields = [
    { name: 'Time', value: new Date().toLocaleDateString('en-GB'), inline: true },
    { name: 'Contact', value: nameValue, inline: true },
  ];
  if (email) fields.push({ name: 'Email', value: email, inline: true });
  if (phone) fields.push({ name: 'Phone', value: phone, inline: true });
  if (webinar) fields.push({ name: 'Webinar', value: webinar, inline: true });

  const utmLines = UTMS.map(([snake, camel]) => {
    const val = firstValue(custom[snake], body[snake], ...attrSources.map((a) => a[camel]), ...attrSources.map((a) => a[snake]));
    return val ? `**${snake}:** ${val}` : '';
  }).filter(Boolean).join('\n');

  fields.push({ name: 'ATTRIBUTION', value: utmLines || 'No UTM data', inline: false });

  return { fields, email, contactId };
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
