const { Telegraf, Markup } = require('telegraf');
const Group = require('./models/Group');
const Job = require('./models/Job');
const BotMessage = require('./models/BotMessage');
const PendingDeletion = require('./models/PendingDeletion');
const { isWhitelisted, whitelistOnly } = require('./middleware/whitelist');
const { parseDuration, formatDuration } = require('./utils/duration');
const { parseTimeOfDay, formatTimeOfDay } = require('./utils/timeOfDay');
const { computeInitialNextRun } = require('./utils/schedule');
const { parseUrlButtonLines, buildUrlButtonsMarkup } = require('./utils/urlButtons');
const wizardState = require('./state');

const bot = new Telegraf(process.env.BOT_TOKEN);

const REPLY_FN = {
  photo: 'replyWithPhoto',
  video: 'replyWithVideo',
  document: 'replyWithDocument',
  animation: 'replyWithAnimation'
};

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

// logs a bot message sent INTO A GROUP (not a broadcast job message) so it can
// be bulk-cleaned later, and schedules its auto-delete if the group has one set
async function logGroupMessage(chatId, messageId) {
  await BotMessage.create({ chatId, messageId });
  const group = await Group.findOne({ chatId });
  if (group && group.autoCleanupSeconds > 0) {
    await PendingDeletion.create({
      chatId,
      messageId,
      deleteAt: new Date(Date.now() + group.autoCleanupSeconds * 1000)
    });
  }
}

async function groupListKeyboard() {
  const groups = await Group.find().sort({ title: 1 });
  const rows = groups.map((g) => [Markup.button.callback(g.title, `grp:${g.chatId}`)]);
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
  const cleanupLabel =
    group.autoCleanupSeconds > 0 ? `อัตโนมัติ: ${formatDuration(group.autoCleanupSeconds)}` : 'อัตโนมัติ: ปิด';
  const text =
    `⚙️ กลุ่ม: <b>${group.title}</b>\n` +
    `ข้อความซ้ำที่ตั้งไว้: ${jobCount} รายการ\n` +
    `🧹 ลบข้อความอื่นๆของบอท: ${cleanupLabel}`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`📋 รายการข้อความซ้ำ (${jobCount})`, `job:list:${chatId}`)],
    [Markup.button.callback('➕ เพิ่มข้อความใหม่', `job:add:${chatId}`)],
    [Markup.button.callback('🧹 ลบข้อความอื่นๆของบอทตอนนี้', `grp:cleanup:${chatId}`)],
    [Markup.button.callback('⏱ ตั้งเวลาลบข้อความอื่นๆอัตโนมัติ', `grp:autocleanup:${chatId}`)],
    [Markup.button.callback('🗑 ลบกลุ่มนี้ออกจากระบบ', `grp:delrequest:${chatId}`)],
    [Markup.button.callback('🔙 กลับไปเลือกกลุ่ม', 'back:groups')]
  ]);
  const opts = { parse_mode: 'HTML', ...kb };
  if (ctx.callbackQuery) return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  return ctx.reply(text, opts);
}

async function cleanupBotMessages(ctx, chatId) {
  const msgs = await BotMessage.find({ chatId });
  let deleted = 0;
  for (const m of msgs) {
    try {
      await bot.telegram.deleteMessage(chatId, m.messageId);
      deleted++;
    } catch (err) {
      // already gone / too old to delete via Bot API — ignore
    }
  }
  await BotMessage.deleteMany({ chatId });
  await PendingDeletion.deleteMany({ chatId, messageId: { $in: msgs.map((m) => m.messageId) } });
  await ctx.answerCbQuery(`ลบแล้ว ${deleted} ข้อความ`).catch(() => {});
  return sendGroupMenu(ctx, chatId);
}

async function sendDeleteGroupConfirm(ctx, chatId) {
  const group = await Group.findOne({ chatId });
  const text =
    `⚠️ ยืนยันลบกลุ่ม <b>${group?.title || chatId}</b> ออกจากระบบ?\n` +
    `ข้อความซ้ำทั้งหมดของกลุ่มนี้จะถูกลบด้วย (บอทจะยังอยู่ในกลุ่มเทเลแกรมตามเดิม ไม่ได้ออกจากกลุ่ม)`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✅ ยืนยันลบ', `grp:delconfirm:${chatId}`)],
    [Markup.button.callback('❌ ยกเลิก', `grp:delcancel:${chatId}`)]
  ]);
  const opts = { parse_mode: 'HTML', ...kb };
  return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
}

async function deleteGroupConfirmed(ctx, chatId) {
  await Job.deleteMany({ chatId });
  await Group.deleteOne({ chatId });
  await BotMessage.deleteMany({ chatId });
  await PendingDeletion.deleteMany({ chatId });
  const text = '🗑 ลบกลุ่มออกจากระบบเรียบร้อยแล้ว';
  await ctx.editMessageText(text).catch(() => ctx.reply(text));
  return sendGroupList(ctx);
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
    const opts = { parse_mode: 'HTML', ...kb };
    return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  }
  const rows = jobs.map((j) => {
    const statusIcon = j.enabled ? '✅' : '⏸';
    const chips = [
      j.text ? '📄' : '',
      j.media && j.media.fileId ? '🖼' : '',
      j.urlButtons && j.urlButtons.length ? '🔗' : ''
    ].join('');
    const preview = j.text ? truncate(j.text.replace(/\n/g, ' '), 22) : '(ยังไม่มีข้อความ)';
    return [
      Markup.button.callback(`${statusIcon} ${chips || '·'} ${preview}`, `job:view:${chatId}:${j._id}`)
    ];
  });
  rows.push([Markup.button.callback('➕ เพิ่มข้อความใหม่', `job:add:${chatId}`)]);
  rows.push([Markup.button.callback('🔙 กลับ', `grp:${chatId}`)]);
  const text = `📋 ข้อความซ้ำในกลุ่ม <b>${group?.title || chatId}</b>`;
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };
  return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
}

// the "recurring message" content-builder screen (Text / Media / Url Buttons)
async function renderJobBuilder(ctx, chatId, jobId) {
  const job = await Job.findById(jobId);
  if (!job) return ctx.answerCbQuery('ไม่พบรายการนี้').catch(() => {});

  const hasText = !!job.text;
  const hasMedia = !!(job.media && job.media.fileId);
  const btnCount = job.urlButtons ? job.urlButtons.length : 0;

  const text =
    `🕐 <b>ข้อความซ้ำ</b>\n\n` +
    `📄 Text ${hasText ? '✅' : '❌'}\n` +
    `🖼 Media ${hasMedia ? '✅' : '❌'}\n` +
    `🔗 Url Buttons (${btnCount}) ${btnCount ? '✅' : '❌'}\n\n` +
    `☝️ ใช้ปุ่มด้านล่างเพื่อเลือกสิ่งที่ต้องการตั้งค่า\n\n` +
    `⏱ ความถี่: ${job.intervalLabel}\n` +
    `🕐 เริ่มส่งเวลา: ${formatTimeOfDay(job.startHour, job.startMinute)} น.\n` +
    `สถานะ: ${job.enabled ? '✅ เปิดใช้งาน' : '⏸ ปิดใช้งาน'}\n` +
    `📌 ปักหมุด: ${job.pin ? 'เปิด' : 'ปิด'}\n` +
    (job.pin ? `🔔 แจ้งเตือนตอนปักหมุด: ${job.pinNotify ? 'เปิด' : 'ปิด'}\n` : '') +
    `⏳ ลบข้อความอัตโนมัติ: ${formatDuration(job.autoDeleteSeconds)}`;

  const rows = [
    [
      Markup.button.callback('📄 Text', `job:settext:${chatId}:${job._id}`),
      Markup.button.callback('👀 ดู', `job:seetext:${chatId}:${job._id}`)
    ],
    [
      Markup.button.callback('🖼 Media', `job:setmedia:${chatId}:${job._id}`),
      Markup.button.callback('👀 ดู', `job:seemedia:${chatId}:${job._id}`)
    ],
    [
      Markup.button.callback('🔗 Url Buttons', `job:seturlbtn:${chatId}:${job._id}`),
      Markup.button.callback('👀 ดู', `job:seeurlbtn:${chatId}:${job._id}`)
    ],
    [Markup.button.callback('👀 Full preview', `job:preview:${chatId}:${job._id}`)],
    [Markup.button.callback('⏱ ตั้งความถี่ & เวลาเริ่ม', `job:schedule:${chatId}:${job._id}`)],
    [
      Markup.button.callback(job.enabled ? '⏸ ปิดใช้งาน' : '▶️ เปิดใช้งาน', `job:toggle:${chatId}:${job._id}`)
    ],
    [
      Markup.button.callback(job.pin ? '📌 ปิดการปักหมุด' : '📌 เปิดการปักหมุด', `job:pin:${chatId}:${job._id}`)
    ]
  ];
  if (job.pin) {
    rows.push([
      Markup.button.callback(
        job.pinNotify ? '🔔 ปิดแจ้งเตือน Pin' : '🔕 เปิดแจ้งเตือน Pin',
        `job:pinnotify:${chatId}:${job._id}`
      )
    ]);
  }
  rows.push([Markup.button.callback('⏳ ตั้งเวลาลบข้อความอัตโนมัติ', `job:autodel:${chatId}:${job._id}`)]);
  rows.push([Markup.button.callback('🗑 ลบรายการนี้', `job:delete:${chatId}:${job._id}`)]);
  rows.push([Markup.button.callback('🔙 กลับ', `job:list:${chatId}`)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };
  return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
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
  if (!isWhitelisted(ctx.from.id)) return; // silent — no reply for non-whitelisted users
  await upsertGroup(ctx.chat);
  const sent = await ctx.reply('✅ ลงทะเบียนกลุ่มนี้แล้ว ไปที่แชทส่วนตัวกับบอทแล้วพิมพ์ /start เพื่อตั้งค่า');
  await logGroupMessage(ctx.chat.id, sent.message_id);
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
    await BotMessage.deleteMany({ chatId: upd.chat.id });
    await PendingDeletion.deleteMany({ chatId: upd.chat.id });
  }
});

// ---------- callback query router ----------

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Popup buttons live on broadcast messages inside groups — anyone can tap
  // them, so this is handled before (and outside) the whitelist gate below.
  if (data.startsWith('popup:')) {
    const [, jobId, indexStr] = data.split(':');
    const job = await Job.findById(jobId).catch(() => null);
    const btn = job?.urlButtons?.[Number(indexStr)];
    if (btn && btn.popupText) {
      return ctx.answerCbQuery(btn.popupText, { show_alert: true }).catch(() => {});
    }
    return ctx.answerCbQuery().catch(() => {});
  }

  if (!isWhitelisted(ctx.from.id)) return ctx.answerCbQuery().catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  if (data === 'back:groups') {
    await sendGroupList(ctx).catch(() => {});
    return ctx.deleteMessage().catch(() => {});
  }

  const [ns, ...rest] = data.split(':');

  if (ns === 'grp') {
    // "grp:<chatId>" (open menu) vs "grp:<action>:<chatId>" (sub-action)
    if (rest.length === 1) return sendGroupMenu(ctx, Number(rest[0]));
    const [action, chatId] = rest;
    if (action === 'cleanup') return cleanupBotMessages(ctx, Number(chatId));
    if (action === 'delrequest') return sendDeleteGroupConfirm(ctx, Number(chatId));
    if (action === 'delconfirm') return deleteGroupConfirmed(ctx, Number(chatId));
    if (action === 'delcancel') return sendGroupMenu(ctx, Number(chatId));
    if (action === 'autocleanup') {
      wizardState.set(ctx.from.id, { step: 'awaiting_group_autocleanup', chatId: Number(chatId) });
      return ctx.reply(
        '⏱ พิมพ์เวลาลบข้อความอื่นๆของบอทอัตโนมัติ (ข้อความที่ไม่ใช่ broadcast เช่น ข้อความยืนยันคำสั่ง)\n' +
          'รูปแบบ: 30s, 10m, 1h\nพิมพ์ "ปิด" เพื่อปิด (ลบด้วยมือผ่านปุ่ม 🧹 เท่านั้น)'
      );
    }
    return;
  }

  if (ns === 'job') {
    const [action, chatId, jobId] = rest;

    if (action === 'list') return sendJobList(ctx, Number(chatId));
    if (action === 'view') return renderJobBuilder(ctx, Number(chatId), jobId);

    if (action === 'add') {
      const job = await Job.create({
        chatId: Number(chatId),
        createdBy: ctx.from.id,
        nextRunAt: computeInitialNextRun(9, 0, 3600)
      });
      return renderJobBuilder(ctx, Number(chatId), job._id);
    }

    if (action === 'settext') {
      wizardState.set(ctx.from.id, { step: 'awaiting_text', chatId: Number(chatId), jobId });
      return ctx.reply(
        '✏️ พิมพ์ข้อความที่ต้องการให้บอทส่ง (รองรับ HTML เช่น <b>ตัวหนา</b>)\nพิมพ์ "ลบ" เพื่อล้างข้อความ'
      );
    }
    if (action === 'seetext') {
      const job = await Job.findById(jobId);
      return ctx.reply(job?.text ? `📄 ข้อความปัจจุบัน:\n\n${job.text}` : '📄 ยังไม่ได้ตั้งค่า Text', {
        parse_mode: 'HTML'
      });
    }

    if (action === 'setmedia') {
      wizardState.set(ctx.from.id, { step: 'awaiting_media', chatId: Number(chatId), jobId });
      return ctx.reply('🖼 ส่งรูปภาพ / วิดีโอ / ไฟล์ที่ต้องการแนบ\nพิมพ์ "ลบ" เพื่อล้าง Media');
    }
    if (action === 'seemedia') {
      const job = await Job.findById(jobId);
      if (!job || !job.media || !job.media.fileId) return ctx.reply('🖼 ยังไม่ได้ตั้งค่า Media');
      const fn = REPLY_FN[job.media.type] || 'replyWithPhoto';
      return ctx[fn](job.media.fileId, { caption: 'ตัวอย่าง Media ปัจจุบัน' });
    }

    if (action === 'seturlbtn') {
      wizardState.set(ctx.from.id, { step: 'awaiting_urlbuttons', chatId: Number(chatId), jobId });
      const text =
        '🔗 <b>ตั้งค่าปุ่มลิงก์ใต้ข้อความ</b>\n' +
        'พิมพ์ข้อความตามรูปแบบนี้:\n\n' +
        '• เพิ่มปุ่มเดียว:\n<code>ชื่อปุ่ม - https://example.com</code>\n\n' +
        '• เพิ่มหลายปุ่มในแถวเดียวกัน:\n<code>ปุ่ม1 - https://a.com && ปุ่ม2 - https://b.com</code>\n\n' +
        '• เพิ่มหลายแถว (ขึ้นบรรทัดใหม่):\n<code>ปุ่ม1 - https://a.com\nปุ่ม2 - https://b.com</code>\n\n' +
        '<u>ปุ่มพิเศษ</u>\n' +
        '• ปุ่มแสดง popup (ไม่เปิดลิงก์):\n<code>ชื่อปุ่ม - popup: ข้อความที่จะแสดง</code>\n\n' +
        'ข้อความนี้จะแทนที่ปุ่มเดิมทั้งหมด';
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('⚡ สร้างปุ่มแบบทีละขั้นตอน', 'btnwiz:start')],
        [Markup.button.callback('🚫 ล้างปุ่มทั้งหมด', `job:clearurlbtn:${chatId}:${jobId}`)],
        [Markup.button.callback('❌ ยกเลิก', `job:cancelwizard:${chatId}:${jobId}`)]
      ]);
      return ctx.reply(text, { parse_mode: 'HTML', ...kb });
    }
    if (action === 'seeurlbtn') {
      const job = await Job.findById(jobId);
      if (!job || !job.urlButtons || job.urlButtons.length === 0) return ctx.reply('🔗 ยังไม่ได้ตั้งค่า Url Buttons');
      return ctx.reply('🔗 ปุ่มปัจจุบัน (กดทดสอบได้):', {
        reply_markup: buildUrlButtonsMarkup(job.urlButtons, job._id)
      });
    }

    if (action === 'clearurlbtn') {
      const job = await Job.findById(jobId);
      if (!job) return;
      job.urlButtons = [];
      await job.save();
      wizardState.delete(ctx.from.id);
      return renderJobBuilder(ctx, Number(chatId), jobId);
    }

    if (action === 'cancelwizard') {
      wizardState.delete(ctx.from.id);
      return renderJobBuilder(ctx, Number(chatId), jobId);
    }

    if (action === 'preview') {
      const job = await Job.findById(jobId);
      const hasText = !!job?.text;
      const hasMedia = !!(job?.media && job.media.fileId);
      if (!job || (!hasText && !hasMedia)) {
        return ctx.reply('👀 ยังไม่ได้ตั้งค่า Text หรือ Media เลย ไม่มีอะไรให้พรีวิว');
      }
      const reply_markup = buildUrlButtonsMarkup(job.urlButtons, job._id);
      if (hasMedia) {
        const fn = REPLY_FN[job.media.type] || 'replyWithPhoto';
        return ctx[fn](job.media.fileId, { caption: job.text || undefined, parse_mode: 'HTML', reply_markup });
      }
      return ctx.reply(job.text, { parse_mode: 'HTML', reply_markup });
    }

    if (action === 'schedule') {
      wizardState.set(ctx.from.id, { step: 'awaiting_interval', chatId: Number(chatId), jobId });
      return ctx.reply(
        '⏱ พิมพ์ความถี่ในการส่งซ้ำ\n' +
          'รูปแบบ: 30s = 30 วินาที, 15m = 15 นาที, 2h = 2 ชั่วโมง, 1h30m = 1 ชม. 30 นาที\n' +
          '(ขั้นต่ำ 30s เพื่อป้องกันการส่งถี่เกินไป)'
      );
    }

    if (action === 'toggle') {
      const job = await Job.findById(jobId);
      if (!job) return;
      if (!job.enabled) {
        const hasContent = !!job.text || !!(job.media && job.media.fileId);
        if (!hasContent) {
          return ctx
            .answerCbQuery('⚠️ กรุณาตั้งค่า Text หรือ Media ก่อนเปิดใช้งาน', { show_alert: true })
            .catch(() => {});
        }
        job.nextRunAt = computeInitialNextRun(job.startHour, job.startMinute, job.intervalSeconds);
        job.enabled = true;
      } else {
        job.enabled = false;
      }
      await job.save();
      return renderJobBuilder(ctx, Number(chatId), jobId);
    }

    if (action === 'pin') {
      const job = await Job.findById(jobId);
      if (!job) return;
      job.pin = !job.pin;
      await job.save();
      return renderJobBuilder(ctx, Number(chatId), jobId);
    }

    if (action === 'pinnotify') {
      const job = await Job.findById(jobId);
      if (!job) return;
      job.pinNotify = !job.pinNotify;
      await job.save();
      return renderJobBuilder(ctx, Number(chatId), jobId);
    }

    if (action === 'autodel') {
      wizardState.set(ctx.from.id, { step: 'awaiting_autodelete', chatId: Number(chatId), jobId });
      return ctx.reply(
        '⏳ พิมพ์เวลาลบข้อความอัตโนมัติ หลังส่ง/ปักหมุด\n' +
          'รูปแบบ: 30s, 10m, 1h, 1h30m\nพิมพ์ "ปิด" เพื่อปิดการลบอัตโนมัติ'
      );
    }

    if (action === 'delete') {
      await Job.deleteOne({ _id: jobId });
      return sendJobList(ctx, Number(chatId));
    }
  }

  if (ns === 'btnwiz') {
    const [action] = rest;
    const st = wizardState.get(ctx.from.id);

    if (action === 'start') {
      if (!st || !st.chatId || !st.jobId) return;
      wizardState.set(ctx.from.id, { step: 'btnwiz_title', chatId: st.chatId, jobId: st.jobId, rows: [[]] });
      return ctx.reply('พิมพ์ชื่อปุ่มที่ 1:');
    }

    if (!st || !st.rows) return;

    if (action === 'sameline') {
      st.step = 'btnwiz_title';
      wizardState.set(ctx.from.id, st);
      return ctx.reply('พิมพ์ชื่อปุ่มถัดไป (แถวเดียวกัน):');
    }

    if (action === 'newrow') {
      st.rows.push([]);
      st.step = 'btnwiz_title';
      wizardState.set(ctx.from.id, st);
      return ctx.reply('พิมพ์ชื่อปุ่มถัดไป (ขึ้นแถวใหม่):');
    }

    if (action === 'done') {
      const job = await Job.findById(st.jobId);
      if (!job) {
        wizardState.delete(ctx.from.id);
        return;
      }
      const flat = [];
      st.rows.forEach((row, rowIndex) => {
        row.forEach((b) => flat.push({ row: rowIndex, text: b.text, url: b.url || null, popupText: b.popupText || null }));
      });
      if (flat.length === 0) {
        wizardState.delete(ctx.from.id);
        return renderJobBuilder(ctx, st.chatId, st.jobId);
      }
      job.urlButtons = flat;
      await job.save();
      const chatId = st.chatId;
      const jobId = st.jobId;
      wizardState.delete(ctx.from.id);
      await ctx.reply(`✅ สร้างปุ่มเรียบร้อย (${flat.length} ปุ่ม)`);
      return renderJobBuilder(ctx, chatId, jobId);
    }

    if (action === 'cancel') {
      const chatId = st.chatId;
      const jobId = st.jobId;
      wizardState.delete(ctx.from.id);
      return renderJobBuilder(ctx, chatId, jobId);
    }
  }
});

// ---------- wizard input (private chat only): text replies + media uploads ----------

bot.on('message', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (!isWhitelisted(ctx.from.id)) return next();
  const st = wizardState.get(ctx.from.id);
  if (!st) return next();

  const text = ctx.message.text; // undefined for media-only messages
  const raw = text ? text.trim() : '';
  const rawLower = raw.toLowerCase();

  switch (st.step) {
    case 'awaiting_text': {
      if (text === undefined) return ctx.reply('❌ พิมพ์ข้อความ (ตัวอักษร) เท่านั้น หรือพิมพ์ "ลบ" เพื่อล้าง');
      const job = await Job.findById(st.jobId);
      if (!job) {
        wizardState.delete(ctx.from.id);
        return;
      }
      job.text = rawLower === 'ลบ' ? '' : text;
      await job.save();
      wizardState.delete(ctx.from.id);
      await ctx.reply('✅ บันทึก Text แล้ว');
      return renderJobBuilder(ctx, st.chatId, st.jobId);
    }

    case 'awaiting_media': {
      if (text !== undefined) {
        if (rawLower === 'ลบ') {
          const job = await Job.findById(st.jobId);
          if (!job) {
            wizardState.delete(ctx.from.id);
            return;
          }
          job.media = { fileId: null, type: null };
          await job.save();
          wizardState.delete(ctx.from.id);
          await ctx.reply('✅ ล้าง Media แล้ว');
          return renderJobBuilder(ctx, st.chatId, st.jobId);
        }
        return ctx.reply('❌ กรุณาส่งรูปภาพ/วิดีโอ/ไฟล์ หรือพิมพ์ "ลบ" เพื่อล้าง Media');
      }
      let fileId = null;
      let type = null;
      if (ctx.message.photo) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        type = 'photo';
      } else if (ctx.message.video) {
        fileId = ctx.message.video.file_id;
        type = 'video';
      } else if (ctx.message.document) {
        fileId = ctx.message.document.file_id;
        type = 'document';
      } else if (ctx.message.animation) {
        fileId = ctx.message.animation.file_id;
        type = 'animation';
      }
      if (!fileId) return ctx.reply('❌ ชนิดไฟล์นี้ไม่รองรับ ส่งรูปภาพ/วิดีโอ/เอกสารเท่านั้น');
      const job = await Job.findById(st.jobId);
      if (!job) {
        wizardState.delete(ctx.from.id);
        return;
      }
      job.media = { fileId, type };
      await job.save();
      wizardState.delete(ctx.from.id);
      await ctx.reply('✅ บันทึก Media แล้ว');
      return renderJobBuilder(ctx, st.chatId, st.jobId);
    }

    case 'awaiting_urlbuttons': {
      if (text === undefined) return ctx.reply('❌ พิมพ์ข้อความรูปแบบปุ่มเท่านั้น');
      if (rawLower === 'ลบ' || rawLower === 'ลบทั้งหมด') {
        const job = await Job.findById(st.jobId);
        if (!job) {
          wizardState.delete(ctx.from.id);
          return;
        }
        job.urlButtons = [];
        await job.save();
        wizardState.delete(ctx.from.id);
        await ctx.reply('✅ ล้าง Url Buttons แล้ว');
        return renderJobBuilder(ctx, st.chatId, st.jobId);
      }
      const result = parseUrlButtonLines(text);
      if (result.error) return ctx.reply(`❌ ${result.error}\nลองพิมพ์ใหม่อีกครั้ง`);
      const job = await Job.findById(st.jobId);
      if (!job) {
        wizardState.delete(ctx.from.id);
        return;
      }
      job.urlButtons = result.buttons;
      await job.save();
      wizardState.delete(ctx.from.id);
      await ctx.reply(`✅ บันทึก Url Buttons แล้ว (${result.buttons.length} ปุ่ม)`);
      return renderJobBuilder(ctx, st.chatId, st.jobId);
    }

    case 'awaiting_interval': {
      if (text === undefined) return ctx.reply('❌ พิมพ์ความถี่เป็นตัวอักษร เช่น 30s, 15m, 2h');
      const seconds = parseDuration(raw);
      if (seconds === null || seconds < 30) {
        return ctx.reply('❌ รูปแบบไม่ถูกต้อง หรือน้อยกว่าขั้นต่ำ 30 วินาที\nลองใหม่ เช่น 30s, 15m, 2h, 1h30m');
      }
      st.intervalSeconds = seconds;
      st.intervalLabel = formatDuration(seconds);
      st.step = 'awaiting_start_time';
      wizardState.set(ctx.from.id, st);
      return ctx.reply(
        `⏱ ตั้งความถี่เป็น ${st.intervalLabel} แล้ว\n\n` +
          '🕐 พิมพ์เวลาที่ต้องการให้เริ่มส่งครั้งแรก (24 ชม.) เช่น 09:00, 21:30\n' +
          'หรือพิมพ์ "now" เพื่อเริ่มส่งรอบแรกทันที'
      );
    }

    case 'awaiting_start_time': {
      if (text === undefined) return ctx.reply('❌ พิมพ์เวลาเป็นตัวอักษร เช่น 09:00 หรือ "now"');
      const job = await Job.findById(st.jobId);
      if (!job) {
        wizardState.delete(ctx.from.id);
        return;
      }
      job.intervalSeconds = st.intervalSeconds;
      job.intervalLabel = st.intervalLabel;
      if (rawLower === 'now') {
        const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
        job.startHour = bkkNow.getUTCHours();
        job.startMinute = bkkNow.getUTCMinutes();
        job.nextRunAt = new Date(); // fires on the next 15s tick
      } else {
        const t = parseTimeOfDay(raw);
        if (!t) return ctx.reply('❌ รูปแบบเวลาไม่ถูกต้อง ลองใหม่ เช่น 09:00, 21:30 หรือพิมพ์ "now"');
        job.startHour = t.hour;
        job.startMinute = t.minute;
        job.nextRunAt = computeInitialNextRun(t.hour, t.minute, st.intervalSeconds);
      }
      await job.save();
      wizardState.delete(ctx.from.id);
      await ctx.reply('✅ บันทึกตารางเวลาแล้ว');
      return renderJobBuilder(ctx, st.chatId, st.jobId);
    }

    case 'awaiting_autodelete': {
      if (text === undefined) return ctx.reply('❌ พิมพ์เวลาเป็นตัวอักษร เช่น 10m หรือ "ปิด"');
      const job = await Job.findById(st.jobId);
      if (!job) {
        wizardState.delete(ctx.from.id);
        return;
      }
      if (rawLower === 'ปิด' || rawLower === 'off') {
        job.autoDeleteSeconds = 0;
      } else {
        const seconds = parseDuration(raw);
        if (seconds === null || seconds < 5) {
          return ctx.reply('❌ รูปแบบไม่ถูกต้อง ลองใหม่ เช่น 30s, 10m, 1h หรือพิมพ์ "ปิด"');
        }
        job.autoDeleteSeconds = seconds;
      }
      await job.save();
      wizardState.delete(ctx.from.id);
      await ctx.reply('✅ บันทึกการลบข้อความอัตโนมัติแล้ว');
      return renderJobBuilder(ctx, st.chatId, st.jobId);
    }

    case 'awaiting_group_autocleanup': {
      if (text === undefined) return ctx.reply('❌ พิมพ์เวลาเป็นตัวอักษร เช่น 10m หรือ "ปิด"');
      const group = await Group.findOne({ chatId: st.chatId });
      if (!group) {
        wizardState.delete(ctx.from.id);
        return;
      }
      if (rawLower === 'ปิด' || rawLower === 'off') {
        group.autoCleanupSeconds = 0;
      } else {
        const seconds = parseDuration(raw);
        if (seconds === null || seconds < 5) {
          return ctx.reply('❌ รูปแบบไม่ถูกต้อง ลองใหม่ เช่น 30s, 10m, 1h หรือพิมพ์ "ปิด"');
        }
        group.autoCleanupSeconds = seconds;
      }
      await group.save();
      wizardState.delete(ctx.from.id);
      await ctx.reply('✅ บันทึกแล้ว');
      return sendGroupMenu(ctx, st.chatId);
    }

    case 'btnwiz_title': {
      if (text === undefined) return ctx.reply('❌ พิมพ์ชื่อปุ่มเป็นตัวอักษร');
      if (!raw) return ctx.reply('❌ ชื่อปุ่มห้ามว่าง ลองใหม่');
      st.pendingTitle = raw;
      st.step = 'btnwiz_target';
      wizardState.set(ctx.from.id, st);
      return ctx.reply('พิมพ์ลิงก์ (https://...) หรือพิมพ์ "popup: ข้อความ" สำหรับปุ่มแสดงข้อความ');
    }

    case 'btnwiz_target': {
      if (text === undefined) return ctx.reply('❌ พิมพ์ลิงก์ หรือ "popup: ข้อความ"');
      const popupMatch = /^popup\s*:\s*(.+)$/i.exec(raw);
      let newBtn;
      if (popupMatch) {
        newBtn = { text: st.pendingTitle, popupText: popupMatch[1].trim(), url: null };
      } else {
        if (!/^https?:\/\//i.test(raw) && !/^tg:\/\//i.test(raw)) {
          return ctx.reply('❌ ลิงก์ไม่ถูกต้อง ต้องขึ้นต้นด้วย http://, https:// หรือ tg:// หรือพิมพ์ "popup: ข้อความ"');
        }
        newBtn = { text: st.pendingTitle, url: raw, popupText: null };
      }
      st.rows[st.rows.length - 1].push(newBtn);
      delete st.pendingTitle;
      st.step = 'btnwiz_continue';
      wizardState.set(ctx.from.id, st);
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('➕ เพิ่มปุ่มแถวเดียวกัน', 'btnwiz:sameline')],
        [Markup.button.callback('⬇️ ขึ้นแถวใหม่', 'btnwiz:newrow')],
        [Markup.button.callback('✅ เสร็จสิ้น', 'btnwiz:done')],
        [Markup.button.callback('❌ ยกเลิก', 'btnwiz:cancel')]
      ]);
      return ctx.reply(`✅ เพิ่มปุ่ม "${newBtn.text}" แล้ว\nต้องการทำอะไรต่อ?`, kb);
    }

    case 'btnwiz_continue': {
      return ctx.reply('กรุณากดปุ่มด้านบนเพื่อดำเนินการต่อ หรือกด ❌ ยกเลิก');
    }

    default:
      return next();
  }
});

module.exports = bot;
