// v1.0

require('dotenv').config();
const express = require('express');
const app = express();

const stripeRoutes = require('./routes/stripe');
app.use('/stripe', stripeRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ghlRoutes = require('./routes/ghl');
const typeformRoutes = require('./routes/typeform');
const whopRoutes = require('./routes/whop');
const eodRoutes = require('./routes/eod');

app.use('/ghl', ghlRoutes);
app.use('/typeform', typeformRoutes);
app.use('/whop', whopRoutes);
app.use('/eod', eodRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'Monster Tasks Automation is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
