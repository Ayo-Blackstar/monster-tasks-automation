const axios = require('axios');

async function sendDiscordMessage(webhookUrl, embed) {
  try {
    if (!webhookUrl) return;
    await axios.post(webhookUrl, { embeds: [embed] });
  } catch (error) {
    console.error('Discord webhook error:', error.message);
  }
}

function createEmbed(title, fields, color) {
  return {
    title,
    color,
    fields: fields
      .filter(f => f.value && f.value !== 'N/A' && f.value !== '')
      .map(f => ({
        name: f.name,
        value: String(f.value).substring(0, 1024),
        inline: f.inline !== false
      })),
    timestamp: new Date().toISOString(),
    footer: { text: 'BSM Bot • Opportunity Pipeline' }
  };
}

const COLORS = {
  GREEN: 0x57F287,
  BLUE: 0x5865F2,
  PURPLE: 0x9B59B6,
  YELLOW: 0xF1C40F,
  RED: 0xED4245,
  GOLD: 0xF59E0B,
  ORANGE: 0xE67E22,
};

module.exports = { sendDiscordMessage, createEmbed, COLORS };
