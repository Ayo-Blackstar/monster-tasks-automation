const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');
const { google } = require('googleapis');

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function getContactGHLLink(contactId) {
  const locationId = process.env.GHL_LOCATION_ID;
  return `https://app.gohighlevel.com/location/${locationId}/contacts/detail/${contactId}`;
}

function buildCallFields(body, stage) {
  const contactId = body.contact_id || body.contactId || '';
  const contactName = body.contact_name || body.full_name || 'Unknown';
  const ghlLink = getContactGHLLink(contactId);

  return [
    { name: 'Stage', value: stage, inline: true },
    { name: 'Name', value: `[${contactName}](${ghlLink})`, inline: true },
    { name: 'Email', value: body.email || '', inline: true },
    { name: 'Phone', value: body.phone || '', inline: true },
    { name: 'First_name', value: body.first_name || contactName.split(' ')[0] || '', inline: true },
    { name: 'Last_name', value: body.last_name || contactName.split(' ').slice(1).join(' ') || '', inline: true },
    { name: 'Full_name', value: contactName, inline: true },
    { name: 'Tags', value: body.tags || '', inline: true },
    { name: 'Country', value: body.country || '', inline: true },
    { name: 'Timezone', value: body.timezone || '', inline: true },
    { name: 'Date_created', value: body.date_created || '', inline: true },
    { name: 'Contact_source', value: body.contact_source || 'Calendly', inline: true },
    { name: 'Opportunity_name', value: body.opportunity_name || contactName, inline: true },
    { name: 'Lead_value', value: body.opportunity_value || '', inline: true },
    { name: 'Source', value: body.calendar_name || '', inline: true },
    { name: 'Pipleline_stage', value: stage, inline: true },
    { name: 'Pipeline_name', value: body.pipeline_name || '', inline: true },
    { name: 'Owner', value: body.assigned_user || '', inline: true },
  ];
}

async function addToSheet(body) {
  try {
    const sheets = await getSheets();
    const spreadsheetId = process.env.REVENUE_SHEET_ID;
    const now = new Date().toLocaleDateString('en-GB');
    const contactId = body.contact_id || body.contactId || '';
    const profileLink = getContactGHLLink(contactId);

    const row = [
      body.contact_name || body.full_name || '',
      body.email || '',
      now,
      body.calendar_name || '',
      profileLink,
      now,
      body.appointment_date || '',
      '', '', '', '', '', '',
      body.appointment_id || '',
      '',
      body.assigned_user || '',
      body.timezone || '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `Sales CRM!A:Q`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
  } catch (err) {
    console.error('Google Sheets error:', err.message);
  }
}

router.post('/booked-call', async (req, res) => {
  try {
    const embed = createEmbed('📞 Pipeline: Call Booked', buildCallFields(req.body, 'Call Booked'), COLORS.PURPLE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_BOOKED_CALLS, embed);
    await addToSheet(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/confirmed-call', async (req, res) => {
  try {
    const embed = createEmbed('✅ Pipeline: Confirmed Call', buildCallFields(req.body, 'Confirmed'), COLORS.GREEN);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_CONFIRMED_CALLS, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/no-show', async (req, res) => {
  try {
    const embed = createEmbed('❌ Pipeline: No Show', buildCallFields(req.body, 'No Show'), COLORS.RED);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NO_SHOW, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancelled', async (req, res) => {
  try {
    const embed = createEmbed('🚫 Pipeline: Cancelled', buildCallFields(req.body, 'Cancelled'), COLORS.ORANGE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_CANCELLED, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/follow-up', async (req, res) => {
  try {
    const embed = createEmbed('🔄 Pipeline: Follow Up', buildCallFields(req.body, 'Follow Up'), COLORS.YELLOW);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_FOLLOW_UP, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rescheduled', async (req, res) => {
  try {
    const embed = createEmbed('🔁 Pipeline: Rescheduled', buildCallFields(req.body, 'Rescheduled'), COLORS.BLUE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_RESCHEDULED, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/second-call', async (req, res) => {
  try {
    const embed = createEmbed('📲 Pipeline: 2nd Call', buildCallFields(req.body, '2nd Call'), COLORS.PURPLE);
    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_SECOND_CALL, embed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/closed-deal', async (req, res) => {
  try {
    const contactId = req.body.contact_id || req.body.contactId || '';
    const contactName = req.body.contact_name || req.body.full_name || 'Unknown';
    const ghlLink = getContactGHLLink(contactId);

    const fields = [
      { name: 'Stage', value: 'Closed', inline: true },
      { name: 'Name', value: `[${contactName}](${ghlLink})`, inline: true },
      { name: 'Email', value: req.body.email || '', inline: true },
      { name: 'Phone', value: req.body.phone || '', inline: true },
      { name: 'Full_name', value: contactName, inline: true },
      { name: 'Tags', value: req.body.tags || '', inline: true },
      { name: 'Country', value: req.body.country || '', inline: true },
      { name: 'Timezone', value: req.body.timezone || '', inline: true },
      { name: 'Date_created', value: req.body.date_created || '', inline: true },
      { name: 'Opportunity_name', value: req.body.opportunity_name || contactName, inline: true },
      { name: 'Lead_value', value: req.body.opportunity_value || '', inline: true },
      { name: 'Pipleline_stage', value: 'Closed', inline: true },
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
