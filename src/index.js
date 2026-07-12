require('dotenv').config();
const express = require('express');
const { connectDB } = require('./db');
const bot = require('./bot');
const { loadAllJobs } = require('./scheduler');

async function main() {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is missing');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');

  await connectDB();
  await loadAllJobs(bot);

  await bot.launch();
  console.log('Bot started (polling).');

  // Render web services require an open HTTP port.
  const app = express();
  app.get('/', (_req, res) => res.send('Telegram broadcast bot is running.'));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Health server listening on :${port}`));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
