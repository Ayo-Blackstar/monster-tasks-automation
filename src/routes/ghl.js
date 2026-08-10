const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');
const axios = require('axios');

const recentNotifications = new Map();
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function isDuplicate(key) {
  const now = Date.now();
  if (recentNotifications.has(key)) {
    const timestamp = recentNotifications.get(key);
    if (now - timestamp < DEDUP_WINDOW_MS) {
      console.log(`Duplicate blocked: ${key}`);
      return true;
    }
  }
  recentNotifications.set(key, now);
  for (const [k, t] of recentNotifications.entries()) {
    if (now - t > DEDUP_WINDOW_MS) recentNotifications.delete(k);
  }
  return false;
}

function getContactGHLLink(contactId) {
  const locationId = process.env.GHL_LOCATION_ID;
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

function determineLeadColor(body) {
  const tags = (body.tags || '').toLowerCase();
  const leadValue = parseFloat(body.opportunity_value || body.lead_value || '0');

  if (tags.includes('gold-lead') || leadValue >= 1997) {
    return { color: COLORS.GOLD, prefix: '🥇', price: '$1,997' };
  } else if (tags.includes('green-lead')) {
    return { color: COLORS.GREEN, prefix: '🟢', price: '$1,997' };
  }
  return { color: COLORS.BLUE, prefix: '📞', price: '$1,997' };
}

async function fetchGHLContact(contactId) {
  try {
    const response = await axios.get(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );
    return response.data?.contact;
  } catch (err) {
    console.error('GHL contact fetch error:', err.message);
    return null;
  }
}

function mergeContactData(body, fullContact) {
  if (!fullContact) return body;

  const merged = { ...body };
  merged.full_name = merged.full_name || `${fullContact.firstName || ''} ${fullContact.lastName || ''}`.trim();
  merged.email = merged.email || fullContact.email;
  merged.phone = merged.phone || fullContact.phone;
  merged.company_name = fullContact.companyName || merged.company_name;
  merged.tags = Array.isArray(fullContact.tags) ? fullContact.tags.join(', ') : (merged.tags || '');

  const customFields = fullContact.customFields || [];
  customFields.forEach(f => {
    if (f.id === 'gsMF4d6KKOjoxo7t4KwB') merged.monthly_revenue = f.value;
    if (f.id === '2iUPlFtQBHj59EORVWHM') merged.problems = f.value;
    if (f.id === 'kVehP7Paep36dS94d5f9') merged.team_size = f.value;
    if (f.id === 'SyFFXP2cKAMDbbp3HfvM') merged.hours_per_week = f.value;
    if (f.id === 'ovJsFnaGKlgh00T3qf1s') merged.business_dependency = f.value;
  });

  return merged;
}

function buildCallFields(body, stage) {
  const contactId = body.contact_id || body.contactId || '';
  const contactName = body.contact_name || body.full_name ||
    `${body.first_name || ''} ${body.last_name || ''}`.trim() || 'Unknown';
  const ghlLink = getContactGHLLink(contactId);

  const fields = [
    { name: 'Stage', value: stage, inline: true },
    { name: 'Name', value: `[${contactName}](${ghlLink})`, inline: true },
    { name: 'Email', value: body.email || '', inline: true },
    { name: 'Phone', value: body.phone || '', inline: true },
    { name: 'Company', value: body.company_name || body.company || '', inline: true },
    { name: 'Tags', value: body.tags || '', inline: true },
    { name: 'Country', value: body.country || '', inline: true },
    { name: 'Timezone', value: body.timezone || '', inline: true },
    { name: 'Contact_source', value: body.contact_source || '', inline: true },
    { name: 'Opportunity_name', value: body.opportunity_name || contactName, inline: true },
    { name: 'Opportunity_value', value: body.opportunity_value || '', inline: true },
    { name: 'Pipeline_name', value: body.pipeline_name || '', inline: true },
    { name: 'Owner', value: body.assigned_user || '', inline: true },
  ];

  if (body.monthly_revenue) fields.push({ name: 'Monthly Revenue', value: body.monthly_revenue, inline: true });
  if (body.team_size) fields.push({ name: 'Team Size', value: body.team_size, inline: true });
  if (body.hours_per_week) fields.push({ name: 'Hours Delegatable', value: body.hours_per_week, inline: true });
  if (body.business_dependency) fields.push({ name: 'Business Dependency', value: body.business_dependency, inline: true });
  if (body.problems) fields.push({ name: 'Problems & Bottlenecks', value: String(body.problems).substring(0, 1024), inline: false });

  return fields;
}

function buildStageFields(body, stage) {
  const contactId = body.contact_id || body.contactId || '';
  const contactName = body.contact_name || body.full_name ||
    `${body.first_name || ''} ${body.last_name || ''}`.trim() || 'Unknown';
  const ghlLink = getContactGHLLink(contactId);

  return [
    { name: 'Stage', value: stage, inline: true },
    { name: 'Name', value: `[${contactName}](${ghlLink})`, inline: true },
    { name: 'Email', value: body.email || '', inline: true },
    { name: 'Phone', value: body.phone || '', inline: true },
    { name: 'Full_name', value: contactName, inline: true },
    { name: 'Company', value: body.company_name || body.company || '', inline: true },
    { name: 'Tags', value: body.tags || '', inline: true },
    { name: 'Country', value: body.country || '', inline: true },
    { name: 'Timezone', value: body.timezone || '', inline: true },
    { name: 'Date_created', value: body.date_created || '', inline: true },
    { name: 'Contact_source', value: body.contact_source || '', inline: true },
    { name: 'Opportunity_name', value: body.opportunity_name || contactName, inline: true },
    { name: 'Opportunity_value', value: body.opportunity_value || '', inline: true },
    { name: 'Pipeline_name', value: body.pipeline_name || '', inline: true },
    { name: 'Owner', value: body.assigned_user || '', inline: true },
  ];
}

router.post('/booked-call', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `booked-${contactId}-${req.body.email || ''}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    // Fetch full contact to get all custom fields
    const fullContact = contactId ? await fetchGHLContact(contactId) : null;
    const mergedBody = mergeContactData(req.body, fullContact);

    const { color, prefix, price } = determineLeadColor(mergedBody);
    const embed = createEmbed(`${prefix} New Call Booked - ${price}`, buildCallFields(mergedBody, 'Call Booked'), color);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_BOOKED_CALLS, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/confirmed-call', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `confirmed-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const { color } = determineLeadColor(req.body);
    const embed = createEmbed('✅ Pipeline: Confirmed Call', buildStageFields(req.body, 'Confirmed'), color);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_CONFIRMED_CALLS, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/no-show', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `noshow-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const embed = createEmbed('❌ Pipeline: No Show', buildStageFields(req.body, 'No Show'), COLORS.RED);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NO_SHOW, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/follow-up', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `followup-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const embed = createEmbed('🔄 Pipeline: Follow Up', buildStageFields(req.body, 'Follow Up'), COLORS.YELLOW);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_FOLLOW_UP, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancelled', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `cancelled-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const embed = createEmbed('🚫 Pipeline: Booking Cancelled', buildStageFields(req.body, 'Booking Cancelled'), COLORS.ORANGE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_CANCELLED, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rescheduled', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `rescheduled-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const embed = createEmbed('🔁 Pipeline: Rescheduled', buildStageFields(req.body, 'Rescheduled'), COLORS.BLUE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_RESCHEDULED, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/second-call', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `secondcall-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const { color } = determineLeadColor(req.body);
    const embed = createEmbed('📲 Pipeline: 2nd Consultation', buildStageFields(req.body, '2nd Consultation'), color);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_SECOND_CALL, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/closed-deal', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const dedupKey = `closed-${contactId}`;
    if (isDuplicate(dedupKey)) return res.json({ success: true, skipped: 'duplicate' });

    const contactName = req.body.contact_name || req.body.full_name ||
      `${req.body.first_name || ''} ${req.body.last_name || ''}`.trim() || 'Unknown';
    const ghlLink = getContactGHLLink(contactId);

    const fields = [
      { name: 'Stage', value: 'Closed', inline: true },
      { name: 'Name', value: `[${contactName}](${ghlLink})`, inline: true },
      { name: 'Email', value: req.body.email || '', inline: true },
      { name: 'Phone', value: req.body.phone || '', inline: true },
      { name: 'Full_name', value: contactName, inline: true },
      { name: 'Company', value: req.body.company_name || req.body.company || '', inline: true },
      { name: 'Tags', value: req.body.tags || '', inline: true },
      { name: 'Country', value: req.body.country || '', inline: true },
      { name: 'Timezone', value: req.body.timezone || '', inline: true },
      { name: 'Opportunity_name', value: req.body.opportunity_name || contactName, inline: true },
      { name: 'Opportunity_value', value: req.body.opportunity_value || '', inline: true },
      { name: 'Pipeline_name', value: req.body.pipeline_name || '', inline: true },
      { name: 'Owner', value: req.body.assigned_user || '', inline: true },
      { name: 'Notes', value: req.body.opportunity_notes || '', inline: false },
    ];

    const embed = createEmbed('🏆 Pipeline: Closed Deal', fields, COLORS.GOLD);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_CLOSED_DEAL, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
