const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');

function buildPaymentFields(data) {
  return [
    { name: '👤 Full Name', value: data.name || 'N/A', inline: true },
    { name: '💰 Amount', value: data.amount || 'N/A', inline: true },
    { name: '📧 Email', value: data.email || 'N/A', inline: true },
    { name: '📞 Phone', value: data.phone || 'N/A', inline: true },
    { name: '🛍️ Product', value: data.product || 'N/A', inline: true },
  ];
}

router.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    const action = event.action || event.event;
    const data = event.data || {};

    let name = 'N/A', email = 'N/A', phone = 'N/A', amount = 'N/A', product = 'N/A';

    if (data.user) {
      name = data.user.name || data.user.username || 'N/A';
      email = data.user.email || 'N/A';
      phone = data.user.phone_number || 'N/A';
    }
    if (data.final_amount !== undefined) {
      amount = `£${(data.final_amount / 100).toFixed(2)}`;
    } else if (data.amount !== undefined) {
      amount = `£${(data.amount / 100).toFixed(2)}`;
    }
    if (data.product) {
      product = data.product.name || 'N/A';
    } else if (data.plan) {
      product = data.plan.plan_type || 'N/A';
    }

    const fields = buildPaymentFields({ name, email, phone, amount, product });

    if (action === 'payment_succeeded' || action === 'membership_activated') {
      const embed = createEmbed('💳 New Whop Payment', fields, COLORS.GOLD);
      await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NEW_PAYMENTS, embed);
    } else if (action === 'payment_failed' || action === 'membership_deactivated') {
      const embed = createEmbed('❌ Failed Whop Payment', fields, COLORS.RED);
      await sendDiscordMessage(process.env.DISCORD_WEBHOOK_FAILED_PAYMENTS, embed);
    } else if (action === 'dispute_created') {
      const embed = createEmbed('⚠️ Whop Dispute', fields, COLORS.ORANGE);
      await sendDiscordMessage(process.env.DISCORD_WEBHOOK_FAILED_PAYMENTS, embed);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Whop handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
