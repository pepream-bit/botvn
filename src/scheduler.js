const cron = require('node-cron');
const Job = require('./models/Job');
const PendingDeletion = require('./models/PendingDeletion');

const tasks = new Map(); // jobId(string) -> cron ScheduledTask

async function sendJob(bot, jobId) {
  const job = await Job.findById(jobId);
  if (!job || !job.enabled) return;
  try {
    const msg = await bot.telegram.sendMessage(job.chatId, job.text, {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
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
    await job.save();

    if (job.autoDeleteMinutes > 0) {
      await PendingDeletion.create({
        chatId: job.chatId,
        messageId: msg.message_id,
        deleteAt: new Date(Date.now() + job.autoDeleteMinutes * 60000)
      });
    }
  } catch (err) {
    console.error(`[job ${job._id}] send failed:`, err.message);
  }
}

// Stored in Mongo (not setTimeout) so scheduled deletions survive a Render restart.
async function sweepPendingDeletions(bot) {
  const due = await PendingDeletion.find({ deleteAt: { $lte: new Date() } });
  for (const d of due) {
    try {
      await bot.telegram.deleteMessage(d.chatId, d.messageId);
    } catch (err) {
      // already deleted / too old for the Bot API to remove — ignore
    }
    await PendingDeletion.deleteOne({ _id: d._id });
  }
}

function startDeletionSweeper(bot) {
  cron.schedule('* * * * *', () => sweepPendingDeletions(bot), { timezone: 'Asia/Bangkok' });
}

function unscheduleJob(jobId) {
  const key = String(jobId);
  const t = tasks.get(key);
  if (t) {
    t.stop();
    tasks.delete(key);
  }
}

function scheduleJob(bot, job) {
  unscheduleJob(job._id);
  if (!job.enabled) return;
  if (!cron.validate(job.cron)) {
    console.error(`[job ${job._id}] invalid cron expression: ${job.cron}`);
    return;
  }
  const task = cron.schedule(job.cron, () => sendJob(bot, job._id), {
    timezone: 'Asia/Bangkok'
  });
  tasks.set(String(job._id), task);
}

async function loadAllJobs(bot) {
  const jobs = await Job.find({ enabled: true });
  jobs.forEach((job) => scheduleJob(bot, job));
  console.log(`Loaded ${jobs.length} active job(s).`);
}

module.exports = {
  scheduleJob,
  unscheduleJob,
  loadAllJobs,
  sendJob,
  startDeletionSweeper,
  sweepPendingDeletions
};
