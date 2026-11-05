const express = require('express');
const router = express.Router();
const { sendDiscordMessage, COLORS } = require('../utils/discord');

// Safety filters (added after old BSM rows were re-sent in one batch):
//   1. Header rows are skipped (submitted_at = "Timestamp", or answers that just repeat the questions)
//   2. Old submissions are skipped: anything submitted more than EOD_MAX_AGE_HOURS ago (default 48)
//   3. The exact same submission is only posted once (per form + timestamp + answers), for 7 days
const MAX_AGE_HOURS = () => Number(process.env.EOD_MAX_AGE_HOURS) || 48;
const seen = new Map();
const SEEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function getEmbedConfig(formTitle) {
  const title = formTitle.toLowerCase();
  if (title.includes('closer')) {
    return { emoji: '📊', label: 'Closer EOD', color: COLORS.BLUE, channel: 'daily_reports' };
  } else if (title.includes('setter') && title.includes('manager')) {
    return { emoji: '💼', label: 'Sales / Setter Manager EOD', color: COLORS.GOLD, channel: 'daily_reports' };
  } else if (title.includes('setter')) {
    return { emoji: '📋', label: 'Setter EOD', color: COLORS.GREEN, channel: 'daily_reports' };
  } else if (title.includes('company')) {
    return { emoji: '🏢', label: 'Company-wide EOD', color: COLORS.PURPLE, channel: 'daily_reports' };
  } else if (title.includes('advertis') || title.includes('ad report') || title.includes('ads')) {
    return { emoji: '📈', label: 'Ad Reports', color: COLORS.ORANGE, channel: 'ad_reports' };
  } else if (title.includes('post call') || title.includes('call note')) {
    return { emoji: '📞', label: 'Post Call Report', color: COLORS.PURPLE, channel: 'daily_reports' };
  } else {
    return { emoji: '📋', label: formTitle, color: COLORS.BLUE, channel: 'daily_reports' };
  }
}

function getWebhookUrl(channel) {
  switch (channel) {
    case 'ad_reports':
      return process.env.DISCORD_WEBHOOK_AD_REPORTS;
    case 'daily_reports':
    default:
      return process.env.DISCORD_WEBHOOK_DAILY_REPORTS;
  }
}

// Header row = timestamp says "Timestamp", or most answers are just the question repeated
function isHeaderRow(submittedAt, answers) {
  if (String(submittedAt).trim().toLowerCase() === 'timestamp') return true;
  const entries = Object.entries(answers);
  if (!entries.length) return false;
  const repeats = entries.filter(([q, a]) => String(a || '').trim().toLowerCase() === String(q).trim().toLowerCase()).length;
  return repeats / entries.length >= 0.5;
}

// True if submitted_at can be read as a date and is older than the allowed age
function isTooOld(submittedAt) {
  if (!submittedAt) return false;
  const t = new Date(submittedAt).getTime();
  if (isNaN(t)) return false; // can't read the date — let it through
  return Date.now() - t > MAX_AGE_HOURS() * 60 * 60 * 1000;
}

function isRepeat(formTitle, submittedAt, answers) {
  const key = `${formTitle}|${submittedAt}|${JSON.stringify(answers)}`;
  const now = Date.now();
  for (const [k, t] of seen.entries()) {
    if (now - t > SEEN_WINDOW_MS) seen.delete(k);
  }
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    const formTitle = payload.form_title || 'EOD Report';
    const rawSubmittedAt = payload.submitted_at || '';
    const submittedAt = rawSubmittedAt || new Date().toLocaleString();
    const answers = payload.answers || {};

    if (isHeaderRow(rawSubmittedAt, answers)) {
      console.log(`[eod] Header row skipped: ${formTitle}`);
      return res.json({ success: true, skipped: 'header row' });
    }
    if (isTooOld(rawSubmittedAt)) {
      console.log(`[eod] Old submission skipped: ${formTitle} — submitted ${rawSubmittedAt}`);
      return res.json({ success: true, skipped: 'older than ' + MAX_AGE_HOURS() + 'h' });
    }
    if (isRepeat(formTitle, rawSubmittedAt, answers)) {
      console.log(`[eod] Repeat submission skipped: ${formTitle} — ${rawSubmittedAt}`);
      return res.json({ success: true, skipped: 'already posted' });
    }

    const config = getEmbedConfig(formTitle);

    const discordFields = Object.entries(answers).map(([question, answer]) => ({
      name: question.substring(0, 256),
      value: String(answer || 'N/A').substring(0, 1024),
      inline: true
    }));

    const embed = {
      title: `${config.emoji} ${config.label}`,
      description: `Submitted at ${submittedAt}`,
      color: config.color,
      fields: discordFields,
      timestamp: new Date().toISOString(),
      footer: { text: 'BSM Form Bot' }
    };

    const webhookUrl = getWebhookUrl(config.channel);
    await sendDiscordMessage(webhookUrl, embed);
    console.log(`[eod] Posted: ${formTitle} — ${submittedAt}`);

    res.json({ success: true });
  } catch (err) {
    console.error('EOD webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = { isHeaderRow, isTooOld };
