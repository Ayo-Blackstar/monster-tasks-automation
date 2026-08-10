const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');
const axios = require('axios');

const processedEmails = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

function isDuplicateEmail(email) {
  if (!email) return false;
  const now = Date.now();
  if (processedEmails.has(email)) {
    const timestamp = processedEmails.get(email);
    if (now - timestamp < DEDUP_WINDOW_MS) {
      console.log(`Duplicate email blocked: ${email}`);
      return true;
    }
  }
  processedEmails.set(email, now);
  for (const [k, t] of processedEmails.entries()) {
    if (now - t > DEDUP_WINDOW_MS) processedEmails.delete(k);
  }
  return false;
}

function abbreviateTitle(title) {
  const map = {
    'how many people currently work': 'Team Size',
    'how many hours each week': 'Hours Delegatable',
    'how much do you spend on payroll': 'Monthly Payroll',
    'first name': 'First Name',
    'last name': 'Last Name',
    'phone number': 'Phone',
    'email': 'Email',
    'company': 'Company',
    'where is the business most dependent': 'Business Dependency',
    'what is your average monthly business revenue': 'Monthly Revenue',
    'the investment for our program': 'Investment',
    'what are your current problems': 'Problems & Bottlenecks',
    'now book in a time': 'Call Booking',
  };
  const lower = title.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (lower.includes(key)) return val;
  }
  return title;
}

function isCalendlyBookingUrl(value) {
  return value && value.includes('calendly.com') && value.includes('invitees');
}

function determineLeadTier(answers, fields_def) {
  let hasHighRevenue = false;
  let hasInvestment = false;
  let firstName = '';
  let lastName = '';
  let email = '';
  let phone = '';
  let company = '';
  let monthlyRevenue = '';
  let problems = '';
  let teamSize = '';
  let hoursPerWeek = '';
  let businessDependency = '';

  answers.forEach((answer, index) => {
    const fieldDef = fields_def[index];
    const fieldTitle = (fieldDef?.title || '').toLowerCase();
    let value = '';

    if (answer.type === 'choice') value = answer.choice?.label || '';
    else if (answer.type === 'choices') value = answer.choices?.labels?.join(', ') || '';
    else if (answer.type === 'text') value = answer.text || '';
    else if (answer.type === 'email') {
      value = answer.email || '';
      email = value;
    }
    else if (answer.type === 'phone_number') {
      value = answer.phone_number || '';
      phone = value;
    }
    else if (answer.type === 'number') {
      value = String(answer.number) || '';
    }

    const valueLower = value.toLowerCase();

    if (fieldTitle.includes('first name')) firstName = value;
    if (fieldTitle.includes('last name')) lastName = value;
    if (fieldTitle.includes('company')) company = value;
    if (fieldTitle.includes('how many people currently work')) teamSize = value;
    if (fieldTitle.includes('how many hours each week')) hoursPerWeek = value;
    if (fieldTitle.includes('where is the business most dependent')) businessDependency = value;

    if (fieldTitle.includes('monthly business revenue') || fieldTitle.includes('average monthly')) {
      monthlyRevenue = value;
      const numericValue = parseFloat(value.replace(/[^0-9.]/g, ''));
      if (
        numericValue >= 10000 ||
        valueLower.includes('$10k') || valueLower.includes('10k+') ||
        valueLower.includes('$15k') || valueLower.includes('$20k') ||
        valueLower.includes('$25k') || valueLower.includes('$30k') ||
        valueLower.includes('$50k') || valueLower.includes('$100k') ||
        valueLower.includes('10-25k') || valueLower.includes('25-49k') ||
        valueLower.includes('above $10') || valueLower.includes('over $10') ||
        valueLower.includes('more than $10')
      ) {
        hasHighRevenue = true;
      }
    }

    if (fieldTitle.includes('investment') || fieldTitle.includes('$1997') || fieldTitle.includes('1997')) {
      if (
        valueLower.includes('yes') ||
        valueLower.includes('i can invest') ||
        valueLower.includes('i have') ||
        valueLower.includes('available')
      ) {
        hasInvestment = true;
      }
    }

    if (fieldTitle.includes('problems') || fieldTitle.includes('bottlenecks')) {
      if (value && !value.toLowerCase().includes('we use your responses')) {
        problems = value;
      }
    }
  });

  if (hasHighRevenue && hasInvestment) {
    return { tier: 'gold', color: COLORS.GOLD, prefix: '🥇', label: 'QUALIFIED', opportunityValue: 1997, source: 'qualified', firstName, lastName, email, phone, company, monthlyRevenue, problems, teamSize, hoursPerWeek, businessDependency };
  } else if (hasInvestment) {
    return { tier: 'green', color: COLORS.GREEN, prefix: '🟢', label: 'QUALIFIED', opportunityValue: 1997, source: 'qualified', firstName, lastName, email, phone, company, monthlyRevenue, problems, teamSize, hoursPerWeek, businessDependency };
  } else {
    return { tier: 'blue', color: COLORS.BLUE, prefix: '📞', label: 'UNQUALIFIED', opportunityValue: 0, source: 'unqualified', firstName, lastName, email, phone, company, monthlyRevenue, problems, teamSize, hoursPerWeek, businessDependency };
  }
}

async function createGHLContact(contactData) {
  try {
    const response = await axios.post(
      'https://services.leadconnectorhq.com/contacts/',
      contactData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log('GHL contact created:', response.data?.contact?.id);
    return response.data?.contact;
  } catch (err) {
    if (err.response?.status === 400 && err.response?.data?.meta?.contactId) {
      console.log('GHL contact already exists:', err.response.data.meta.contactId);
      return { id: err.response.data.meta.contactId };
    }
    console.error('GHL contact error:', err.response?.status, JSON.stringify(err.response?.data));
    return null;
  }
}

async function createGHLOpportunity(contact, stageId, tierData) {
  try {
    const pipelineId = process.env.GHL_PIPELINE_ID;
    if (!pipelineId || !stageId || !contact?.id) return null;

    const name = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email || 'New Lead';

    const response = await axios.post(
      'https://services.leadconnectorhq.com/opportunities/',
      {
        pipelineId,
        pipelineStageId: stageId,
        contactId: contact.id,
        name,
        locationId: process.env.GHL_LOCATION_ID,
        status: 'open',
        monetaryValue: tierData.opportunityValue,
        source: tierData.source,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log('GHL opportunity created:', response.data?.opportunity?.id);
    return response.data?.opportunity;
  } catch (err) {
    console.error('GHL opportunity error:', err.response?.status, JSON.stringify(err.response?.data));
    return null;
  }
}

async function findAndUpdateOpportunityStage(contactId, stageId) {
  try {
    const pipelineId = process.env.GHL_PIPELINE_ID;
    if (!pipelineId || !stageId || !contactId) return null;

    const response = await axios.get(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${process.env.GHL_LOCATION_ID}&contact_id=${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    const opportunities = response.data?.opportunities || [];
    const opportunity = opportunities.find(o => o.pipelineId === pipelineId);

    if (opportunity) {
      await axios.put(
        `https://services.leadconnectorhq.com/opportunities/${opportunity.id}`,
        { pipelineStageId: stageId },
        {
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );
      console.log('GHL opportunity stage updated');
      return opportunity;
    }
    return null;
  } catch (err) {
    console.error('GHL opportunity update error:', err.response?.status, JSON.stringify(err.response?.data));
    return null;
  }
}

router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const answers = payload.form_response?.answers || [];
    const fields_def = payload.form_response?.definition?.fields || [];
    const hidden = payload.form_response?.hidden || {};

    const tierData = determineLeadTier(answers, fields_def);
    const { color, prefix, label, firstName, lastName, email, phone, company, tier, monthlyRevenue, problems, teamSize, hoursPerWeek, businessDependency } = tierData;

    if (!email && !phone && !firstName) {
      return res.json({ success: true, skipped: 'no contact info' });
    }

    const discordFields = [];
    let hasCalendly = false;
    let calendlyValue = '';

    const now = new Date().toLocaleDateString('en-GB');
    discordFields.push({ name: 'Time', value: now, inline: true });

    answers.forEach((answer, index) => {
      const fieldDef = fields_def[index];
      const rawTitle = fieldDef?.title || `Question ${index + 1}`;
      const fieldTitle = abbreviateTitle(rawTitle);
      let value = '';

      switch (answer.type) {
        case 'text':
          value = answer.text || '';
          break;
        case 'email':
          value = answer.email || '';
          break;
        case 'phone_number':
          value = answer.phone_number || '';
          break;
        case 'choice':
          value = answer.choice?.label || '';
          break;
        case 'choices':
          value = answer.choices?.labels?.join(', ') || '';
          break;
        case 'boolean':
          value = answer.boolean ? 'Yes' : 'No';
          break;
        case 'number':
          value = String(answer.number) || '';
          break;
        case 'calendly':
          if (!hasCalendly) {
            hasCalendly = true;
            calendlyValue = answer.url || 'Call Booked ✅';
          }
          return;
        case 'url':
          value = answer.url || '';
          if (isCalendlyBookingUrl(value)) {
            if (!hasCalendly) {
              hasCalendly = true;
              calendlyValue = value;
            }
            return;
          }
          break;
        default:
          value = answer.url || answer.text || answer.email || '';
          if (isCalendlyBookingUrl(value)) {
            if (!hasCalendly) {
              hasCalendly = true;
              calendlyValue = value;
            }
            return;
          }
      }

      // Skip hint text
      if (value && value.toLowerCase().includes('we use your responses')) return;

      if (value) {
        discordFields.push({
          name: fieldTitle.substring(0, 256),
          value: String(value).substring(0, 1024),
          inline: true
        });
      }
    });

    // Add UTM data
    if (hidden && Object.keys(hidden).length > 0) {
      const utmLines = Object.entries(hidden)
        .filter(([k, v]) => v)
        .map(([k, v]) => `**${k}:** ${v}`)
        .join('\n');
      if (utmLines) {
        discordFields.push({ name: 'ATTRIBUTION', value: utmLines, inline: false });
      }
    }

    // Build custom fields for GHL contact
    const customFields = [];
    if (monthlyRevenue) customFields.push({ id: 'gsMF4d6KKOjoxo7t4KwB', value: monthlyRevenue });
    if (problems) customFields.push({ id: '2iUPlFtQBHj59EORVWHM', value: problems });
    if (teamSize) customFields.push({ id: 'kVehP7Paep36dS94d5f9', value: teamSize });
    if (hoursPerWeek) customFields.push({ id: 'SyFFXP2cKAMDbbp3HfvM', value: hoursPerWeek });
    if (businessDependency) customFields.push({ id: 'ovJsFnaGKlgh00T3qf1s', value: businessDependency });

    // Always create GHL contact
    const contact = await createGHLContact({
      firstName,
      lastName,
      email,
      phone,
      companyName: company,
      locationId: process.env.GHL_LOCATION_ID,
      source: 'typeform',
      tags: ['typeform-lead', `${tier}-lead`],
      customFields,
    });

    if (hasCalendly) {
      if (contact?.id) {
        const existing = await findAndUpdateOpportunityStage(
          contact.id,
          process.env.GHL_PIPELINE_BOOKED_STAGE_ID
        );
        if (!existing) {
          await createGHLOpportunity(contact, process.env.GHL_PIPELINE_BOOKED_STAGE_ID, tierData);
        }
      }

      // Send new lead to Discord
      const newLeadTitle = `${prefix} New Lead - ${label}`;
      const newLeadEmbed = createEmbed(newLeadTitle, discordFields, color);
      await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NEW_LEADS, newLeadEmbed);

    } else {
      if (!isDuplicateEmail(email) && contact?.id) {
        await createGHLOpportunity(contact, process.env.GHL_PIPELINE_STAGE_ID, tierData);

        const newLeadTitle = `${prefix} New Lead - ${label}`;
        const newLeadEmbed = createEmbed(newLeadTitle, discordFields, color);
        await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NEW_LEADS, newLeadEmbed);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Typeform error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
