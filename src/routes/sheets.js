// src/routes/sheets.js
// Business Worksheet → GHL contact + opportunity notes
//
// The Google Sheet's Apps Script (sheet-notes-sync.gs) POSTs here whenever a "Notes" cell
// is edited on the Sales CRM tab:
//   POST /sheets/call-notes
//   Header: x-sync-secret: <SHEETS_SYNC_SECRET>
//   Body:   { contact_id, email, name, notes, status, call_recording, date, appointment_id, row }
//
// What it does:
//   1. Finds the GHL contact: by contact_id (the sheet's "Profile Link" column) or, failing that, by email
//   2. Adds the call notes as a contact note — or UPDATES the same note if that call's notes are edited
//      again, so the contact doesn't fill up with duplicates (matched by appointment ID / date)
//   3. Writes the notes onto the contact's open opportunity (PUT /opportunities/{id} — GHL has no
//      opportunity /notes endpoint)
//
// Railway env vars:
//   GHL_API_KEY, GHL_LOCATION_ID   (already set)
//   GHL_PIPELINE_ID                (already set — used to pick the right opportunity)
//   SHEETS_SYNC_SECRET             any random string; the same value goes in the Apps Script

const express = require('express');
const router = express.Router();

const GHL_BASE = 'https://services.leadconnectorhq.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function ghl(method, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GHL ${method} ${path} → ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

// GHL contact IDs are 20-char alphanumeric strings; anything else in the column is ignored
function looksLikeContactId(v) {
  return /^[A-Za-z0-9]{15,30}$/.test(clean(v));
}

async function findContact({ contact_id, email }) {
  if (looksLikeContactId(contact_id)) {
    try {
      const d = await ghl('GET', `/contacts/${clean(contact_id)}`);
      if (d.contact?.id) return d.contact;
    } catch (e) {
      console.warn('[sheets] Contact ID lookup failed, trying email:', e.message);
    }
  }
  if (email) {
    const d = await ghl('GET', `/contacts/?locationId=${process.env.GHL_LOCATION_ID}&query=${encodeURIComponent(clean(email))}`);
    const match = (d.contacts || []).find((c) => clean(c.email).toLowerCase() === clean(email).toLowerCase());
    if (match) return match;
  }
  return null;
}

// One note per call: the marker line lets us find and update it when the notes are edited again
function buildNote(b) {
  const key = clean(b.appointment_id) || clean(b.date) || `row ${clean(b.row)}`;
  const marker = `📞 Call Notes (Sales CRM sheet) — ${key}`;
  const lines = [marker, ''];
  if (clean(b.date)) lines.push(`Date: ${clean(b.date)}`);
  if (clean(b.status)) lines.push(`Status: ${clean(b.status)}`);
  if (clean(b.call_recording)) lines.push(`Recording: ${clean(b.call_recording)}`);
  lines.push('', clean(b.notes));
  return { marker, text: lines.join('\n') };
}

async function upsertContactNote(contactId, note) {
  const d = await ghl('GET', `/contacts/${contactId}/notes`);
  const existing = (d.notes || []).find((n) => clean(n.body).startsWith(note.marker));
  if (existing) {
    await ghl('PUT', `/contacts/${contactId}/notes/${existing.id}`, { body: note.text });
    return `updated note ${existing.id}`;
  }
  const created = await ghl('POST', `/contacts/${contactId}/notes`, { body: note.text });
  return `created note ${created.note?.id || ''}`;
}

async function updateOpportunityNotes(contactId, note) {
  const d = await ghl('GET', `/opportunities/search?location_id=${process.env.GHL_LOCATION_ID}&contact_id=${contactId}`);
  const opps = d.opportunities || [];
  if (!opps.length) return 'no opportunity';
  const opp =
    opps.find((o) => o.pipelineId === process.env.GHL_PIPELINE_ID && o.status === 'open') ||
    opps.find((o) => o.pipelineId === process.env.GHL_PIPELINE_ID) ||
    opps.find((o) => o.status === 'open') ||
    opps[0];
  await ghl('PUT', `/opportunities/${opp.id}`, { notes: note.text });
  return `updated opportunity ${opp.id}`;
}

router.post('/call-notes', async (req, res) => {
  const secret = process.env.SHEETS_SYNC_SECRET;
  if (secret && req.get('x-sync-secret') !== secret) {
    console.warn('[sheets] Rejected: bad or missing x-sync-secret');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const b = req.body || {};
  if (!clean(b.notes)) return res.json({ success: true, skipped: 'empty notes' });
  if (!clean(b.contact_id) && !clean(b.email)) {
    return res.status(400).json({ error: 'need contact_id or email' });
  }

  try {
    const contact = await findContact(b);
    if (!contact) {
      console.warn(`[sheets] No GHL contact for ${b.email || b.contact_id} (row ${b.row})`);
      return res.status(404).json({ error: 'contact not found', email: b.email || null });
    }

    const note = buildNote(b);
    const noteResult = await upsertContactNote(contact.id, note);
    let oppResult = '';
    try {
      oppResult = await updateOpportunityNotes(contact.id, note);
    } catch (e) {
      oppResult = `opportunity error: ${e.message}`;
    }

    console.log(`[sheets] Row ${b.row} — ${b.name || b.email} → ${noteResult}; ${oppResult}`);
    res.json({ success: true, contactId: contact.id, note: noteResult, opportunity: oppResult });
  } catch (err) {
    console.error('[sheets] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = { buildNote, looksLikeContactId };
