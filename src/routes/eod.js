const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');

function getEmbedConfig(formTitle) {
  const title = formTitle.toLowerCase();
  if (title.includes('closer')) {
    return { emoji: '📊', label: 'Closer EOD', color: COLORS.BLUE };
  } else if (title.includes('setter') && title.includes('manager')) {
    return { emoji: '💼', label: 'Sales / Setter Manager EOD', color: COLORS.GOLD };
  } else if (title.includes('setter')) {
    return { emoji: '📋', label: 'Setter EOD', color: COLORS.GREEN };
  } else if (title.includes('company')) {
    return { emoji: '🏢', label: 'Company-wide EOD', color: COLORS.PURPLE };
  } else if (title.includes('advertis') || title.includes('ad report')) {
    return { emoji: '📈', label: 'Ad Reports', color: COLORS.ORANGE };
  } else if (title.includes('post call')) {
    return { emoji: '📞', label: 'Post Call Report', color: COLORS.PURPLE };
  } else {
    return { emoji: '📋', label: formTitle, color: COLORS.BLUE };
  }
}

router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const formTitle = payload.form_title || 'EOD Report';
    const submittedAt = payload.submitted_at || new Date().toLocaleString();
    const answers = payload.answers || {};
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

    await sendDiscordMessage(process.env.DISCORD_WEBHOOK_DAILY_REPORTS, embed);
    res.json({ success: true });
  } catch (err) {
    console.error('EOD webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
