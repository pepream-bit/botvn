const cron = require('node-cron');
const Job = require('./models/Job');
const PendingDeletion = require('./models/PendingDeletion');
const BotMessage = require('./models/BotMessage');
const { advanceNextRun } = require('./utils/schedule');
const { buildUrlButtonsMarkup } = require('./utils/urlButtons');

const MEDIA_SEND_FN = {
  photo: 'sendPhoto',
  video: 'sendVideo',
  document: 'sendDocument',
  animation: 'sendAnimation'
};

async function sendJob(bot, job) {
  const hasText = !!job.text;
  const hasMedia = !!(job.media && job.media.fileId);
  if (!hasText && !hasMedia) {
    console.warn(`[job ${job._id}] skipped: no text or media set`);
    return;
  }

  try {
    const reply_markup = buildUrlButtonsMarkup(job.urlButtons, job._id);
    let msg;
    if (hasMedia) {
      const fn = MEDIA_SEND_FN[job.media.type] || 'sendPhoto';
      msg = await bot.telegram[fn](job.chatId, job.media.fileId, {
        caption: job.text || undefined,
        parse_mode: 'HTML',
        reply_markup
      });
    } else {
      msg = await bot.telegram.sendMessage(job.chatId, job.text, {
        parse_mode: 'HTML',
        reply_markup,
        disable_web_page_preview: false
      });
    }

    if (job.pin) {
      try {
        await bot.telegram.pinChatMessage(job.chatId, msg.message_id, {
          disable_notification: !job.pinNotify
        });
      } catch (pinErr) {
        console.error(`[job ${job._id}] pin failed:`, pinErr.message);
      }
    }

    job.lastMessageId = msg.message_id;

    if (job.autoDeleteSeconds > 0) {
      await PendingDeletion.create({
        chatId: job.chatId,
        messageId: msg.message_id,
        deleteAt: new Date(Date.now() + job.autoDeleteSeconds * 1000)
      });
    }
  } catch (err) {
    console.error(`[job ${job._id}] send failed:`, err.message);
  }
}

async function sweepPendingDeletions(bot) {
  const due = await PendingDeletion.find({ deleteAt: { $lte: new Date() } });
  for (const d of due) {
    try {
      await bot.telegram.deleteMessage(d.chatId, d.messageId);
    } catch (err) {
      // already deleted / too old for the Bot API to remove — ignore
    }
    await BotMessage.deleteOne({ chatId: d.chatId, messageId: d.messageId });
    await PendingDeletion.deleteOne({ _id: d._id });
  }
}

async function tick(bot) {
  const now = new Date();
  const dueJobs = await Job.find({ enabled: true, nextRunAt: { $lte: now } });
  for (const job of dueJobs) {
    await sendJob(bot, job);
    job.nextRunAt = advanceNextRun(job.nextRunAt || now, job.intervalSeconds);
    await job.save();
  }
  await sweepPendingDeletions(bot);
}

// One global tick (every 15s) drives all repeating jobs AND all scheduled
// deletions — no per-job cron tasks, so a job's schedule is just data (easy
// to change, and correct across restarts since state lives in MongoDB).
function startEngine(bot) {
  cron.schedule('*/15 * * * * *', () => {
    tick(bot).catch((err) => console.error('tick error:', err));
  });
  console.log('Scheduling engine started (15s tick).');
}

module.exports = { startEngine, sendJob, sweepPendingDeletions };
