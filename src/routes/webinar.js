// src/routes/webinar.js
// Monster Tasks — Webinar funnel → Discord
//
// 1) POST /webinar/registration   → #new-leads        🎥 New Webinar Registration (blue)
// 2) POST /webinar/booked-self    → #call-booked      🥇 Webinar Call Booked - SELF-BOOKED (gold)
// 3) POST /webinar/booked-setter  → #call-booked      🟢 Webinar Call Booked - SETTER-BOOKED (green)
//
// Both booked routes also move the contact's opportunity in the Webinar Funnel pipeline to
// "Appointment Booked" (or create one there if the contact has none in that pipeline).
//
// If the same contact hits BOTH booked routes (the self-booked one and the setter one),
// only the SELF-BOOKED notification is posted. The setter route waits 60s before posting
// so the self-booked one always wins.
//
// Custom Data keys the GHL Webhook actions can send (any left out are skipped):
//   contact_id, first_name, last_name, full_name, email, phone, webinar, qualification,
//   appointment_time, calendar, booked_by, utm_source, utm_medium, utm_campaign, utm_content, utm_term
//
// UTMs are read from (first one that has a value wins):
//   1. Custom Data (utm_source, ...) → arrives in body.customData
//   2. Top-level keys (utm_source, ...)
//   3. GHL's own attribution on the contact (attributionSource / lastAttributionSource)
//
// Railway env vars used:
//   DISCORD_WEBHOOK_NEW_LEADS, DISCORD_WEBHOOK_BOOKED_CALLS, GHL_API_KEY, GHL_LOCATION_ID
//   WEBINAR_PIPELINE_ID          optional, default CFhGJODB2MSWYCNDPWg8 (Webinar Funnel)
//   WEBINAR_BOOKED_STAGE_ID      optional, default 44f244e1-a414-4028-ac77-fc00a696da60 (Appointment Booked)

const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const WEBINAR_PIPELINE_ID = () => process.env.WEBINAR_PIPELINE_ID || 'CFhGJODB2MSWYCNDPWg8';
const WEBINAR_BOOKED_STAGE_ID = () => process.env.WEBINAR_BOOKED_STAGE_ID || '44f244e1-a414-4028-ac77-fc00a696da60';
const SETTER_DELAY_MS = () => Number(process.env.WEBINAR_SETTER_DELAY_MS) || 60 * 1000;

// ---------- dedup ----------
const recent = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const selfBooked = new Map(); // contact key -> time a self-booked notification was posted
const SELF_BOOKED_WINDOW_MS = 30 * 60 * 1000;

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

function markSelfBooked(key) {
  if (!key) return;
  const now = Date.now();
  for (const [k, t] of selfBooked.entries()) {
    if (now - t > SELF_BOOKED_WINDOW_MS) selfBooked.delete(k);
  }
  selfBooked.set(key, now);
}

function wasSelfBooked(key) {
  const t = key && selfBooked.get(key);
  return !!t && Date.now() - t < SELF_BOOKED_WINDOW_MS;
}

// ---------- helpers ----------
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

function readBody(body = {}) {
  const custom = (body.customData && typeof body.customData === 'object') ? body.customData : {};
  const contactObj = (body.contact && typeof body.contact === 'object') ? body.contact : {};
  const appt = (body.appointment && typeof body.appointment === 'object') ? body.appointment : {};
  const calendarObj = (body.calendar && typeof body.calendar === 'object') ? body.calendar : {};
  const attrSources = [
    body.attributionSource,
    contactObj.attributionSource,
    body.lastAttributionSource,
    contactObj.lastAttributionSource,
  ].filter((a) => a && typeof a === 'object');

  const pick = (key, ...extra) => firstValue(custom[key], body[key], ...extra);

  const firstName = pick('first_name');
  const lastName = pick('last_name');
  const d = {
    contactId: pick('contact_id', contactObj.id),
    fullName: pick('full_name', `${firstName} ${lastName}`.trim()),
    email: pick('email'),
    phone: pick('phone'),
    webinar: pick('webinar'),
    qualification: pick('qualification'),
    appointmentTime: pick('appointment_time', appt.startTime, calendarObj.startTime),
    calendar: pick('calendar', calendarObj.calendarName),
    bookedBy: pick('booked_by'),
  };

  d.utmLines = UTMS.map(([snake, camel]) => {
    const val = firstValue(custom[snake], body[snake], ...attrSources.map((a) => a[camel]), ...attrSources.map((a) => a[snake]));
    return val ? `**${snake}:** ${val}` : '';
  }).filter(Boolean).join('\n');

  return d;
}

function contactField(d) {
  const name = d.fullName || d.email || 'Unknown';
  const value = d.contactId
    ? `[${name}](https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/${d.contactId})`
    : name;
  return { name: 'Contact', value, inline: true };
}

// Registration notification (kept exactly as approved by Ayo)
function buildFields(body = {}) {
  const d = readBody(body);
  const fields = [
    { name: 'Time', value: new Date().toLocaleDateString('en-GB'), inline: true },
    contactField(d),
  ];
  if (d.email) fields.push({ name: 'Email', value: d.email, inline: true });
  if (d.phone) fields.push({ name: 'Phone', value: d.phone, inline: true });
  if (d.webinar) fields.push({ name: 'Webinar', value: d.webinar, inline: true });
  if (d.qualification) fields.push({ name: 'Which best describes you right now?', value: d.qualification.slice(0, 1024), inline: false });
  fields.push({ name: 'ATTRIBUTION', value: d.utmLines || 'No UTM data', inline: false });
  return { fields, email: d.email, contactId: d.contactId };
}

// Call booked notification
function buildBookedFields(body = {}) {
  const d = readBody(body);
  const fields = [
    { name: 'Time', value: new Date().toLocaleDateString('en-GB'), inline: true },
    contactField(d),
  ];
  if (d.email) fields.push({ name: 'Email', value: d.email, inline: true });
  if (d.phone) fields.push({ name: 'Phone', value: d.phone, inline: true });
  if (d.appointmentTime) fields.push({ name: 'Appointment', value: d.appointmentTime, inline: true });
  if (d.calendar) fields.push({ name: 'Calendar', value: d.calendar, inline: true });
  if (d.bookedBy) fields.push({ name: 'Booked By', value: d.bookedBy, inline: true });
  fields.push({ name: 'Pipeline', value: 'Webinar Funnel → Appointment Booked', inline: true });
  if (d.qualification) fields.push({ name: 'Which best describes you right now?', value: d.qualification.slice(0, 1024), inline: false });
  fields.push({ name: 'ATTRIBUTION', value: d.utmLines || 'No UTM data', inline: false });
  return { fields, d };
}

// ---------- GHL: move/create opportunity in Webinar Funnel → Appointment Booked ----------
function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function moveToBookedStage(d) {
  if (!d.contactId) {
    console.warn('[webinar] No contact_id — cannot move opportunity');
    return 'skipped (no contact_id)';
  }
  const pipelineId = WEBINAR_PIPELINE_ID();
  const stageId = WEBINAR_BOOKED_STAGE_ID();

  const searchUrl = `${GHL_BASE}/opportunities/search?location_id=${process.env.GHL_LOCATION_ID}&contact_id=${d.contactId}`;
  const sr = await fetch(searchUrl, { headers: ghlHeaders() });
  const sdata = await sr.json().catch(() => ({}));
  if (!sr.ok) throw new Error(`GHL search ${sr.status}: ${JSON.stringify(sdata)}`);

  const existing = (sdata.opportunities || []).find((o) => o.pipelineId === pipelineId);

  if (existing) {
    if (existing.pipelineStageId === stageId) return 'already in Appointment Booked';
    const ur = await fetch(`${GHL_BASE}/opportunities/${existing.id}`, {
      method: 'PUT',
      headers: ghlHeaders(),
      body: JSON.stringify({ pipelineStageId: stageId }),
    });
    if (!ur.ok) throw new Error(`GHL update ${ur.status}: ${await ur.text()}`);
    return `moved ${existing.id}`;
  }

  const cr = await fetch(`${GHL_BASE}/opportunities/`, {
    method: 'POST',
    headers: ghlHeaders(),
    body: JSON.stringify({
      pipelineId,
      pipelineStageId: stageId,
      contactId: d.contactId,
      locationId: process.env.GHL_LOCATION_ID,
      name: d.fullName || d.email || 'Webinar Lead',
      status: 'open',
      source: 'webinar',
    }),
  });
  const cdata = await cr.json().catch(() => ({}));
  if (!cr.ok) throw new Error(`GHL create ${cr.status}: ${JSON.stringify(cdata)}`);
  return `created ${cdata.opportunity?.id || ''}`;
}

async function postBooked(body, type) {
  const { fields, d } = buildBookedFields(body);
  const key = d.contactId || d.email;

  try {
    const result = await moveToBookedStage(d);
    console.log(`[webinar] ${type} opportunity:`, result);
  } catch (e) {
    console.error(`[webinar] ${type} opportunity error:`, e.message);
  }

  const isSelf = type === 'SELF-BOOKED';
  const title = isSelf ? '🥇 Webinar Call Booked - SELF-BOOKED' : '🟢 Webinar Call Booked - SETTER-BOOKED';
  const color = isSelf ? COLORS.GOLD : COLORS.GREEN;

  await sendDiscordMessage(process.env.DISCORD_WEBHOOK_BOOKED_CALLS, createEmbed(title, fields, color));
  console.log(`[webinar] ${type} posted:`, key);
}

// ---------- routes ----------
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

// Self-booked: posts straight away in GOLD
router.post('/booked-self', async (req, res) => {
  try {
    const d = readBody(req.body);
    const key = d.contactId || d.email;
    markSelfBooked(key);

    if (isDuplicate(`self-${key}`)) {
      console.log('[webinar] Duplicate self-booked skipped:', key);
      return res.json({ success: true, skipped: 'duplicate' });
    }

    await postBooked(req.body, 'SELF-BOOKED');
    res.json({ success: true });
  } catch (err) {
    console.error('[webinar] booked-self error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Setter-booked: replies to GHL at once, waits 60s, then posts in GREEN
// unless the same contact was already posted as self-booked
router.post('/booked-setter', (req, res) => {
  const d = readBody(req.body);
  const key = d.contactId || d.email;
  res.json({ success: true, queued: true });

  setTimeout(async () => {
    try {
      if (wasSelfBooked(key)) {
        console.log('[webinar] Setter-booked skipped (already self-booked):', key);
        return;
      }
      if (isDuplicate(`setter-${key}`)) {
        console.log('[webinar] Duplicate setter-booked skipped:', key);
        return;
      }
      await postBooked(req.body, 'SETTER-BOOKED');
    } catch (err) {
      console.error('[webinar] booked-setter error:', err.message);
    }
  }, SETTER_DELAY_MS());
});

module.exports = router;
module.exports._test = { buildFields, buildBookedFields, clean, moveToBookedStage };
