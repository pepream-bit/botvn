const { Telegraf, Markup } = require('telegraf');
const Group = require('./models/Group');
const Job = require('./models/Job');
const { isWhitelisted, whitelistOnly } = require('./middleware/whitelist');
const { PRESETS } = require('./utils/cronPresets');
const { scheduleJob, unscheduleJob } = require('./scheduler');
const wizardState = require('./state');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ---------- helpers ----------

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

async function upsertGroup(chat) {
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  await Group.findOneAndUpdate(
    { chatId: chat.id },
    { chatId: chat.id, title: chat.title, type: chat.type },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function groupListKeyboard() {
  const groups = await Group.find().sort({ title: 1 });
  const rows = groups.map((g) => [
    Markup.button.callback(g.title, `grp:${g.chatId}`)
  ]);
  return { groups, keyboard: Markup.inlineKeyboard(rows) };
}

async function sendGroupList(ctx) {
  const { groups, keyboard } = await groupListKeyboard();
  if (groups.length === 0) {
    return ctx.reply(
      '📭 ยังไม่มีกลุ่มที่บอทถูกเพิ่มเข้าไป\nเพิ่มบอทเข้ากลุ่ม แล้วตั้งเป็นแอดมิน จากนั้นพิมพ์ /register ในกลุ่มนั้น'
    );
  }
  return ctx.reply('📋 เลือกกลุ่มที่ต้องการตั้งค่า:', keyboard);
}

async function sendGroupMenu(ctx, chatId) {
  const group = await Group.findOne({ chatId });
  if (!group) return ctx.answerCbQuery('ไม่พบกลุ่มนี้').catch(() => {});
  const jobCount = await Job.countDocuments({ chatId });
  const text = `⚙️ กลุ่ม: <b>${group.title}</b>\nข้อความซ้ำที่ตั้งไว้: ${jobCount} รายการ`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`📋 รายการข้อความซ้ำ (${jobCount})`, `job:list:${chatId}`)],
    [Markup.button.callback('➕ เพิ่มข้อความใหม่', `job:add:${chatId}`)],
    [Markup.button.callback('🔙 กลับไปเลือกกลุ่ม', 'back:groups')]
  ]);
  const opts = { parse_mode: 'HTML', ...kb };
  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

async function sendJobList(ctx, chatId) {
  const jobs = await Job.find({ chatId }).sort({ createdAt: 1 });
  const group = await Group.findOne({ chatId });
  if (jobs.length === 0) {
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('➕ เพิ่มข้อความใหม่', `job:add:${chatId}`)],
      [Markup.button.callback('🔙 กลับ', `grp:${chatId}`)]
    ]);
    const text = `กลุ่ม <b>${group?.title || chatId}</b> ยังไม่มีข้อความซ้ำ`;
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...kb }));
  }
  const rows = jobs.map((j) => {
    const icon = j.enabled ? '✅' : '⏸';
    const pinIcon = j.pin ? '📌' : '';
    return [
      Markup.button.callback(
        `${icon}${pinIcon} ${truncate(j.text.replace(/\n/g, ' '), 28)}`,
        `job:view:${chatId}:${j._id}`
      )
    ];
  });
  rows.push([Markup.button.callback('➕ เพิ่มข้อความใหม่', `job:add:${chatId}`)]);
  rows.push([Markup.button.callback('🔙 กลับ', `grp:${chatId}`)]);
  const text = `📋 ข้อความซ้ำในกลุ่ม <b>${group?.title || chatId}</b>`;
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };
  return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
}

async function sendJobView(ctx, chatId, jobId) {
  const job = await Job.findById(jobId);
  if (!job) return ctx.answerCbQuery('ไม่พบรายการนี้').catch(() => {});
  const text =
    `📝 <b>ข้อความ</b>\n${job.text}\n\n` +
    `⏱ ความถี่: ${job.intervalLabel || job.cron}\n` +
    `สถานะ: ${job.enabled ? '✅ เปิดใช้งาน' : '⏸ ปิดใช้งาน'}\n` +
    `📌 ปักหมุด: ${job.pin ? 'เปิด' : 'ปิด'}\n` +
    (job.pin ? `🔔 แจ้งเตือนตอนปักหมุด: ${job.pinNotify ? 'เปิด' : 'ปิด'}\n` : '');

  const rows = [
    [
      Markup.button.callback(
        job.enabled ? '⏸ ปิดใช้งาน' : '▶️ เปิดใช้งาน',
        `job:toggle:${chatId}:${job._id}`
      )
    ],
    [Markup.button.callback(job.pin ? '📌 ปิดการปักหมุด' : '📌 เปิดการปักหมุด', `job:pin:${chatId}:${job._id}`)]
  ];
  if (job.pin) {
    rows.push([
      Markup.button.callback(
        job.pinNotify ? '🔔 ปิดแจ้งเตือน Pin' : '🔕 เปิดแจ้งเตือน Pin',
        `job:pinnotify:${chatId}:${job._id}`
      )
    ]);
  }
  rows.push([Markup.button.callback('⏱ เปลี่ยนช่วงเวลา', `job:interval:${chatId}:${job._id}`)]);
  rows.push([Markup.button.callback('🗑 ลบรายการนี้', `job:delete:${chatId}:${job._id}`)]);
  rows.push([Markup.button.callback('🔙 กลับ', `job:list:${chatId}`)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };
  return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
}

function intervalKeyboard(chatId, jobId) {
  const rows = Object.entries(PRESETS).map(([code, p]) => [
    Markup.button.callback(p.label, `interval:set:${chatId}:${jobId}:${code}`)
  ]);
  rows.push([Markup.button.callback('✏️ กำหนดเอง (custom cron)', `interval:custom:${chatId}:${jobId}`)]);
  rows.push([Markup.button.callback('🔙 กลับ', `job:view:${chatId}:${jobId}`)]);
  return Markup.inlineKeyboard(rows);
}

// ---------- commands ----------

bot.command('start', whitelistOnly(), async (ctx) => {
  if (ctx.chat.type !== 'private') return; // config flow is private-chat only
  await sendGroupList(ctx);
});

bot.command('register', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return ctx.reply('ใช้คำสั่งนี้ในกลุ่มเท่านั้น');
  }
  if (!isWhitelisted(ctx.from.id)) return ctx.reply('⛔ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้');
  await upsertGroup(ctx.chat);
  return ctx.reply('✅ ลงทะเบียนกลุ่มนี้แล้ว ไปที่แชทส่วนตัวกับบอทแล้วพิมพ์ /start เพื่อตั้งค่า');
});

// auto-register when bot is added to a group
bot.on('my_chat_member', async (ctx) => {
  const upd = ctx.myChatMember;
  const newStatus = upd.new_chat_member.status;
  if (['member', 'administrator'].includes(newStatus)) {
    await upsertGroup(upd.chat);
  } else if (['left', 'kicked'].includes(newStatus)) {
    await Group.deleteOne({ chatId: upd.chat.id });
    await Job.deleteMany({ chatId: upd.chat.id });
  }
});

// ---------- callback query router ----------

bot.on('callback_query', async (ctx) => {
  if (!isWhitelisted(ctx.from.id)) return ctx.answerCbQuery('⛔ ไม่มีสิทธิ์').catch(() => {});
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery().catch(() => {});

  if (data === 'back:groups') return sendGroupList(ctx).catch(() => {}) && ctx.deleteMessage().catch(() => {});

  const [ns, ...rest] = data.split(':');

  if (ns === 'grp') {
    const [chatId] = rest;
    return sendGroupMenu(ctx, Number(chatId));
  }

  if (ns === 'job') {
    const [action, chatId, jobId] = rest;
    if (action === 'list') return sendJobList(ctx, Number(chatId));
    if (action === 'view') return sendJobView(ctx, Number(chatId), jobId);

    if (action === 'add') {
      wizardState.set(ctx.from.id, { step: 'awaiting_text', chatId: Number(chatId) });
      return ctx.reply('✏️ พิมพ์ข้อความที่ต้องการให้บอทส่งซ้ำ (รองรับ HTML tag เช่น <b>ตัวหนา</b>)');
    }

    if (action === 'toggle') {
      const job = await Job.findById(jobId);
      if (!job) return;
      job.enabled = !job.enabled;
      await job.save();
      scheduleJob(bot, job); // scheduleJob() unschedules internally when job.enabled is false
      return sendJobView(ctx, Number(chatId), jobId);
    }

    if (action === 'pin') {
      const job = await Job.findById(jobId);
      if (!job) return;
      job.pin = !job.pin;
      await job.save();
      return sendJobView(ctx, Number(chatId), jobId);
    }

    if (action === 'pinnotify') {
      const job = await Job.findById(jobId);
      if (!job) return;
      job.pinNotify = !job.pinNotify;
      await job.save();
      return sendJobView(ctx, Number(chatId), jobId);
    }

    if (action === 'interval') {
      return ctx.editMessageText('⏱ เลือกความถี่ในการส่ง:', intervalKeyboard(chatId, jobId)).catch(() =>
        ctx.reply('⏱ เลือกความถี่ในการส่ง:', intervalKeyboard(chatId, jobId))
      );
    }

    if (action === 'delete') {
      await Job.deleteOne({ _id: jobId });
      unscheduleJob(jobId);
      return sendJobList(ctx, Number(chatId));
    }
  }

  if (ns === 'interval') {
    const [action, chatId, jobId, code] = rest;
    if (action === 'set') {
      const preset = PRESETS[code];
      if (!preset) return;
      const job = await Job.findById(jobId);
      if (!job) return;
      job.cron = preset.cron;
      job.intervalLabel = preset.label;
      await job.save();
      scheduleJob(bot, job);
      return sendJobView(ctx, Number(chatId), jobId);
    }
    if (action === 'custom') {
      wizardState.set(ctx.from.id, { step: 'awaiting_cron', chatId: Number(chatId), jobId });
      return ctx.reply(
        '✏️ พิมพ์ cron expression (5 ช่อง, เวลา Asia/Bangkok)\nตัวอย่าง: 0 */2 * * *  (ทุก 2 ชั่วโมง)'
      );
    }
  }
});

// ---------- wizard text input (private chat only) ----------

bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (!isWhitelisted(ctx.from.id)) return next();
  const st = wizardState.get(ctx.from.id);
  if (!st) return next();

  if (st.step === 'awaiting_text') {
    st.text = ctx.message.text;
    st.step = 'awaiting_interval';
    wizardState.set(ctx.from.id, st);
    return ctx.reply('⏱ เลือกความถี่ในการส่ง:', intervalKeyboardForNewJob(st.chatId));
  }

  if (st.step === 'awaiting_cron') {
    const cronLib = require('node-cron');
    const expr = ctx.message.text.trim();
    if (!cronLib.validate(expr)) {
      return ctx.reply('❌ cron expression ไม่ถูกต้อง ลองใหม่อีกครั้ง');
    }
    const job = await Job.findById(st.jobId);
    if (job) {
      job.cron = expr;
      job.intervalLabel = `กำหนดเอง: ${expr}`;
      await job.save();
      scheduleJob(bot, job);
      wizardState.delete(ctx.from.id);
      return sendJobView(ctx, st.chatId, st.jobId);
    }
    wizardState.delete(ctx.from.id);
    return;
  }

  if (st.step === 'awaiting_new_cron') {
    const cronLib = require('node-cron');
    const expr = ctx.message.text.trim();
    if (!cronLib.validate(expr)) {
      return ctx.reply('❌ cron expression ไม่ถูกต้อง ลองใหม่อีกครั้ง');
    }
    return finalizeNewJob(ctx, st, expr, `กำหนดเอง: ${expr}`);
  }

  return next();
});

function intervalKeyboardForNewJob(chatId) {
  const rows = Object.entries(PRESETS).map(([code, p]) => [
    Markup.button.callback(p.label, `newjob:interval:${code}`)
  ]);
  rows.push([Markup.button.callback('✏️ กำหนดเอง (custom cron)', 'newjob:interval:custom')]);
  return Markup.inlineKeyboard(rows);
}

async function finalizeNewJob(ctx, st, cronExpr, label) {
  const group = await Group.findOne({ chatId: st.chatId });
  const job = await Job.create({
    chatId: st.chatId,
    text: st.text,
    cron: cronExpr,
    intervalLabel: label,
    pin: false,
    pinNotify: group ? group.pinNotifyDefault : true,
    enabled: true,
    createdBy: ctx.from.id
  });
  scheduleJob(bot, job);
  wizardState.delete(ctx.from.id);
  await ctx.reply('✅ เพิ่มข้อความซ้ำเรียบร้อยแล้ว');
  return sendJobView(ctx, st.chatId, job._id);
}

bot.action(/^newjob:interval:(.+)$/, async (ctx) => {
  if (!isWhitelisted(ctx.from.id)) return ctx.answerCbQuery('⛔ ไม่มีสิทธิ์').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const code = ctx.match[1];
  const st = wizardState.get(ctx.from.id);
  if (!st) return;

  if (code === 'custom') {
    st.step = 'awaiting_new_cron';
    wizardState.set(ctx.from.id, st);
    return ctx.reply('✏️ พิมพ์ cron expression (5 ช่อง, เวลา Asia/Bangkok)\nตัวอย่าง: 0 */2 * * *');
  }

  const preset = PRESETS[code];
  if (!preset) return;
  return finalizeNewJob(ctx, st, preset.cron, preset.label);
});

module.exports = bot;
