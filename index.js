const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

// 🌌 ระบบฐานข้อมูลดีเอ็นเอชั่วคราว (เก็บคีย์ Username แปลงเป็น ID และเก็บชื่อเล่น)
const usernameCache = {};

// ☢️ ระบบฐานข้อมูลคำเตือนรังสีพิษ (warnData[groupId][userId] = จำนวนครั้ง)
const warnData = {};
const WARN_LIMIT = 2;

// 🔋 ระบบตรวจวัดการเรียกใช้งาน API ป้องกันการถูกระงับสัญญาณ
let apiCounter = 0;
const API_DAILY_MAX = 50000;

// 👥 ระบบ Whitelist (คั่นด้วยลูกน้ำ เช่น 12345,67890)
const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

// 🛰️ ระบบ Multi-Group (รูปแบบ: ID:ชื่อ,ID:ชื่อ)
const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) {
      const id = parts[0].trim();
      const name = parts.slice(1).join(':').trim();
      TARGET_GROUPS.push({ id: parseInt(id), name: name });
    }
  });
}

// ตรวจสอบความพร้อมของระบบ
if (!token || WHITELIST_IDS.length === 0 || TARGET_GROUPS.length === 0 || !LOG_CHANNEL_ID) {
  console.error('❌ CRITICAL ERROR: Interstellar Environment Variables missing!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🛸 Alien Invasion Engine Active! Overlords: ${WHITELIST_IDS.length} | Target Sectors: ${TARGET_GROUPS.length}`);

// ==========================================
// 🔧 ฟังก์ชันช่วยระบบ Warn
// ==========================================
function getWarnCount(groupId, userId) {
  if (!warnData[groupId]) warnData[groupId] = {};
  return warnData[groupId][userId] || 0;
}

function addWarn(groupId, userId) {
  if (!warnData[groupId]) warnData[groupId] = {};
  warnData[groupId][userId] = (warnData[groupId][userId] || 0) + 1;
  return warnData[groupId][userId];
}

function removeWarn(groupId, userId) {
  if (!warnData[groupId] || !warnData[groupId][userId]) return 0;
  warnData[groupId][userId] = Math.max(0, warnData[groupId][userId] - 1);
  return warnData[groupId][userId];
}

function clearWarn(groupId, userId) {
  if (!warnData[groupId]) warnData[groupId] = {};
  warnData[groupId][userId] = 0;
}

function buildWarnBar(current, max) {
  const filled = Math.min(current, max);
  return '☢️'.repeat(filled) + '⬜'.repeat(max - filled);
}

// ==========================================
// 🔧 ฟังก์ชัน parse ลิงก์ Telegram → { chatId, messageId }
// รองรับ: https://t.me/c/CHATID/MSGID และ https://t.me/USERNAME/MSGID
// ==========================================
function parseTelegramLink(url) {
  const trimmed = url.trim();
  if (!trimmed.startsWith('https://t.me/')) return null;
  if (trimmed.includes('/c/')) {
    const parts = trimmed.split('/');
    const msgId = parseInt(parts.pop());
    const chatIdStr = parts.pop();
    if (isNaN(msgId) || !chatIdStr) return null;
    return { chatId: parseInt('-100' + chatIdStr), messageId: msgId };
  } else {
    const parts = trimmed.split('/');
    const msgId = parseInt(parts.pop());
    const username = parts.pop();
    if (isNaN(msgId) || !username) return null;
    return { chatId: '@' + username, messageId: msgId };
  }
}

// ==========================================
// 🔧 ฟังก์ชัน resolve เป้าหมาย → { userId, name, error }
// รองรับ: @username | ตัวเลข ID | ลิงก์ https://t.me/c/...
// ==========================================
async function resolveTarget(input, bot) {
  const trimmed = input.trim();

  // --- รูปแบบ ลิงก์ t.me ---
  if (trimmed.startsWith('https://t.me/')) {
    const parsed = parseTelegramLink(trimmed);
    if (!parsed) return { error: '❌ <b>รูปแบบลิงก์ไม่ถูกต้อง</b>\nตัวอย่างที่ถูกต้อง: <code>https://t.me/c/2802866220/76235</code>' };
    try {
      apiCounter += 2;
      const fwdMsg = await bot.forwardMessage(parsed.chatId, parsed.chatId, parsed.messageId);
      const userId = fwdMsg.forward_from ? fwdMsg.forward_from.id : null;
      const firstName = fwdMsg.forward_from ? (fwdMsg.forward_from.first_name || '') : '';
      const lastName = fwdMsg.forward_from ? (fwdMsg.forward_from.last_name || '') : '';
      const name = `${firstName} ${lastName}`.trim() || 'ไม่ระบุชื่อ';
      // ลบข้อความที่ forward มาเพื่อไม่ให้ล้นกลุ่ม
      apiCounter++;
      bot.deleteMessage(parsed.chatId, fwdMsg.message_id).catch(() => {});
      if (!userId) return { error: '❌ <b>ไม่สามารถดึงข้อมูลเจ้าของข้อความได้</b>\nข้อความนั้นอาจซ่อน forward privacy หรือเป็นบอท' };
      return { userId, name };
    } catch (e) {
      // fallback: ลองดึง userId จาก usernameCache ด้วย chatId ที่รู้
      return { error: `❌ <b>ดึงข้อมูลจากลิงก์ไม่สำเร็จ:</b>\n<code>${e.message}</code>\n💡 <i>หากผู้ใช้เปิด Forward Privacy ให้ใช้ @username หรือ ID แทน</i>` };
    }
  }

  // --- รูปแบบ @username ---
  if (trimmed.startsWith('@')) {
    const key = trimmed.replace('@', '').toLowerCase();
    if (usernameCache[key]) return { userId: usernameCache[key].id, name: usernameCache[key].name };
    return { error: `❌ <b>สแกนดีเอ็นเอล้มเหลว:</b> ไม่พบรหัส ID ของ <code>${trimmed}</code> ในหน่วยความจำยานแม่\n💡 <i>แนะนำ: ให้เป้าหมายส่งข้อความในกลุ่มก่อน หรือวางลิงก์ข้อความของเขาแทน</i>` };
  }

  // --- รูปแบบ ตัวเลข ID ---
  const userId = parseInt(trimmed);
  if (isNaN(userId)) {
    return { error: '❌ <b>รูปแบบไม่ถูกต้อง</b>\nรองรับ: <code>@username</code> | <code>รหัส ID</code> | <code>https://t.me/c/CHATID/MSGID</code>' };
  }
  let name = 'ไม่ระบุชื่อ';
  for (const key in usernameCache) {
    if (usernameCache[key].id === userId) { name = usernameCache[key].name; break; }
  }
  return { userId, name };
}

// ==========================================
// 1. เมนูหลัก Command Center (ระบบ Inline Keyboard)
// ==========================================
function sendMainMenu(chatId) {
  apiCounter++;
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);

  keyboard.push([
    { text: `📊 โควตาพลังงาน API`, callback_data: `view_api_limits` },
    { text: `👥 รายชื่อ Whitelist`, callback_data: `view_whitelist` }
  ]);

  bot.sendMessage(chatId, "🛸 <b>แผงควบคุมหลัก: กองทัพเอเลี่ยนต่างดาว (Alien Attack Machine)</b>\nยินดีต้อนรับท่านผู้บัญชาการ โปรดเลือกเซกเตอร์ดาวเทียมที่ต้องการเข้าควบคุม:", {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 2. จัดการปุ่มกด (Inline Keyboard)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    apiCounter++;
    return bot.answerCallbackQuery(query.id, { text: 'ปฏิเสธการเข้าถึง! โครงข่ายไม่รู้จักรหัสสัญญาณของคุณ', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // กลับหน้าหลัก
  if (data === 'back_to_main') {
    apiCounter += 2;
    bot.deleteMessage(chatId, messageId).catch(() => {});
    sendMainMenu(chatId);
    return bot.answerCallbackQuery(query.id);
  }

  // ดูสถานะ API
  if (data === 'view_api_limits') {
    apiCounter += 2;
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
    const bars = Math.round(pct / 10);
    const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
    
    await bot.sendMessage(chatId, `📊 <b>เครื่องตรวจวัดพลังงานสัญญาณขีดจำกัด API</b>\n\nหลอดพลังงาน: [<code>${barStr}</code>] ${pct}%\nดึงสัญญาณไปแล้ว: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง\n\n⚠️ <i>คำเตือน: โปรดควบคุมการยิงสัญญานไม่ให้ทะลุ 100% เพื่อป้องกันระบบป้องกันของ Telegram ตรวจจับ</i>`, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  // ดูรายชื่อ Whitelist
  if (data === 'view_whitelist') {
    apiCounter += 2;
    let whitelistMessage = `👥 <b>รายชื่อโอเปอเรเตอร์ผู้ควบคุมยานแม่ (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ร่างอวตารนิรนาม (ยังไม่พบประวัติพิมพ์ข้อความ)";
      for (const key in usernameCache) {
        if (usernameCache[key].id === id) {
          name = usernameCache[key].name;
          break;
        }
      }
      whitelistMessage += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    whitelistMessage += `━━━━━━━━━━━━━━━━━━━━\n🛸 <i>สิทธิ์ในการสั่งการและแก้ไขชั้นบรรยากาศสูงสุด</i>`;
    
    await bot.sendMessage(chatId, whitelistMessage, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  // เลือกกลุ่มและแสดงเมนูย่อย
  if (data.startsWith('select_group_')) {
    apiCounter += 2;
    const groupId = data.replace('select_group_', '');
    const group = TARGET_GROUPS.find(g => g.id == groupId);
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'ไม่พบพิกัดเซกเตอร์เป้าหมายในแผนที่ดวงดาว' });

    const submenu = [
      [
        { text: '🔴 ล้างบางเผ่าพันธุ์ (Ban)', callback_data: `opt_ban_${groupId}` },
        { text: '🟢 ชุบชีวิตเนื้อเยื่อ (Unban)', callback_data: `opt_unban_${groupId}` }
      ],
      [
        { text: '☢️ ฉีดรังสีพิษ (Warn)', callback_data: `opt_warn_${groupId}` },
        { text: '🧬 ล้างพิษดีเอ็นเอ (Unwarn)', callback_data: `opt_unwarn_${groupId}` }
      ],
      [
        { text: '🔬 สแกนระดับรังสี (Warn Status)', callback_data: `opt_warncheck_${groupId}` }
      ],
      [
        { text: '🧲 ดูดสื่อไร้ร่องรอย (Stealth)', callback_data: `cmd_capture_url_${groupId}` },
        { text: '📡 ยิงคลื่นประกาศ (Transmit)', callback_data: `opt_ann_${groupId}` }
      ],
      [
        { text: '💬 ตอบกลับด้วยลิงก์ (Reply Link)', callback_data: `opt_replylink_${groupId}` }
      ],
      [
        { text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }
      ]
    ];

    await bot.editMessageText(`🛰️ <b>พิกัดเซกเตอร์ที่ล็อกไว้:</b> <code>${group.name}</code>\nโปรดเลือกคำสั่งโปรโตคอลการโจมตีหรือดูดกลืนข้อมูล:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: submenu }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // เรียกโหมดดูดสื่อประจำกลุ่ม (Stealth)
  if (data.startsWith('cmd_capture_url_')) {
    apiCounter += 2;
    const groupId = data.replace('cmd_capture_url_', '');
    bot.sendMessage(chatId, `🧲 <b>[QUANTUM TRACTOR BEAM] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nป้อนลิงก์เป้าหมาย Telegram ลงในเครื่องสแกนชีวภาพ (เช่น https://t.me/c/xxxx/xxxx):`, {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // Force Reply โหมดต่างๆ
  if (data.startsWith('opt_')) {
    apiCounter += 2;
    const parts = data.split('_');
    const action = parts[1];
    const groupId = parts[2];
    
    if (action === 'ban') {
      bot.sendMessage(chatId, `🔴 <b>[VAPORIZE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุเหยื่อที่จะล้างบาง:\n• <code>@username เหตุผล</code>\n• <code>รหัสเลขID เหตุผล</code>\n• <code>https://t.me/c/CHATID/MSGID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unban') {
      bot.sendMessage(chatId, `🟢 <b>[REANIMATE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุดีเอ็นเอที่จะชุบชีวิตกลับมา:\n• <code>@username เหตุผล</code>\n• <code>รหัสเลขID เหตุผล</code>\n• <code>https://t.me/c/CHATID/MSGID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'warn') {
      bot.sendMessage(chatId, `☢️ <b>[RADIATION INJECTION PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่จะฉีดรังสีพิษ (ครบ ${WARN_LIMIT} ครั้ง = แบนอัตโนมัติ):\n• <code>@username เหตุผล</code>\n• <code>รหัสเลขID เหตุผล</code>\n• <code>https://t.me/c/CHATID/MSGID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unwarn') {
      bot.sendMessage(chatId, `🧬 <b>[DNA DETOX PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่จะถอนรังสีพิษออก 1 ครั้ง:\n• <code>@username เหตุผล</code>\n• <code>รหัสเลขID เหตุผล</code>\n• <code>https://t.me/c/CHATID/MSGID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'warncheck') {
      bot.sendMessage(chatId, `🔬 <b>[RADIATION SCANNER] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่ต้องการสแกนระดับรังสีสะสม:\n• <code>@username</code>\n• <code>รหัสเลขID</code>\n• <code>https://t.me/c/CHATID/MSGID</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'ann') {
      bot.sendMessage(chatId, `📡 <b>[BEAM TRANSMISSION] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งไฟล์ภาพ วิดีโอ หรือข้อความ เพื่อฝังตัวเข้าโครงข่ายประสาทของเซกเตอร์แบบเนทีฟ:`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'replylink') {
      bot.sendMessage(chatId, `💬 <b>[REPLY LINK PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์พิกัดข้อความ ตามด้วยข้อความที่จะตอบกลับแบบเนทีฟ\nรูปแบบ: <code>[ลิงก์ข้อความ] [เว้นวรรค] [ข้อความตอบกลับ]</code>\nตัวอย่าง: <code>https://t.me/c/123/456 เปิดระบบสแกนแล้วมนุษย์โลก</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    }
    bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 3. ระบบประมวลผลสัญญาณข้อความ
// ==========================================
bot.on('message', async (msg) => {
  // 🛰️ ตรวจสแกนดีเอ็นเอผู้ส่งสารทุกคนในกลุ่ม
  if (msg.from && msg.from.username) {
    const usernameKey = msg.from.username.toLowerCase().replace('@', '');
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username;
    usernameCache[usernameKey] = {
      id: msg.from.id,
      name: fullName
    };
  }

  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  if (msg.reply_to_message && msg.reply_to_message.text) {
    const promptText = msg.reply_to_message.text;
    const alienOperatorName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || `@${msg.from.username}` || msg.from.id;

    // ==========================================
    // 🧲 โหมดดูดสื่อไร้ร่องรอย (Quantum Tractor Beam)
    // ==========================================
    if (promptText.includes('[QUANTUM TRACTOR BEAM]')) {
      if (!msg.text) return;
      apiCounter++;
      try {
        const url = msg.text.trim();
        let targetChatId;
        let messageId;

        if (url.includes('/c/')) {
          const parts = url.split('/');
          messageId = parseInt(parts.pop());
          const chatIdStr = parts.pop();
          targetChatId = parseInt("-100" + chatIdStr);
        } else {
          const parts = url.split('/');
          messageId = parseInt(parts.pop());
          const username = parts.pop();
          targetChatId = "@" + username;
        }

        if (!targetChatId || isNaN(messageId)) throw new Error("พิกัดคลื่นพอร์ตดวงดาวไม่ถูกต้อง");

        apiCounter += 2;
        await bot.copyMessage(msg.from.id, targetChatId, messageId);
        bot.sendMessage(msg.from.id, '🛸 <b>กระบวนการดึงวัตถุเสร็จสิ้น ถูกส่งเข้าวงโคจรแชทส่วนตัวของคุณแล้ว ปิดระบบการสืบค้นย้อนกลับ 100%</b>', { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.from.id, `❌ <b>ยานแม่ปฏิเสธการดึงข้อมูล:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ระบบตรวจสอบ ID กลุ่มสำหรับการกระทำอื่นๆ ---
    const matchGroup = promptText.match(/พิกัดเซกเตอร์:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);
    const groupObj = TARGET_GROUPS.find(g => g.id === targetGroupId);
    const groupName = groupObj ? groupObj.name : 'ไม่ระบุกลุ่ม';

    // ==========================================
    // ☢️ โหมดฉีดรังสีพิษ (Radiation Injection / Warn)
    // ==========================================
    if (promptText.includes('[RADIATION INJECTION PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;

      const spaceIdx = msg.text.trim().indexOf(' ');
      const targetInput = spaceIdx === -1 ? msg.text.trim() : msg.text.trim().substring(0, spaceIdx);
      const reason = spaceIdx === -1 ? 'ตรวจพบพฤติกรรมเบี่ยงเบนจากโปรโตคอลกองทัพเอเลี่ยน' : msg.text.trim().substring(spaceIdx + 1).trim() || 'ตรวจพบพฤติกรรมเบี่ยงเบนจากโปรโตคอลกองทัพเอเลี่ยน';

      const resolved = await resolveTarget(targetInput, bot);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name;

      try {
        const currentWarn = addWarn(targetGroupId, targetUserId);
        const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);

        if (currentWarn >= WARN_LIMIT) {
          // ☢️ ครบลิมิต → แบนอัตโนมัติ
          apiCounter += 3;
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId);

          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ แจ้งเตือนการระเบิดรังสี - RADIATION OVERLOAD ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n\n☢️ <b>ระดับรังสีสะสม:</b> [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n\n💥 <b>คำเตือน:</b> <code>${reason}</code>\n\n☠️ <b>สถานะ:</b> ระดับรังสีเกินขีดจำกัด — ร่างกายแตกสลายและถูกขับออกนอกชั้นบรรยากาศ (AUTO-BAN)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>ข้อความนี้จะระเหยสลายใน 60 วินาที...</i>`,
            { parse_mode: 'HTML' }
          );

          setTimeout(() => { apiCounter++; bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          apiCounter += 2;
          await bot.sendMessage(LOG_CHANNEL_ID,
            `📜 <b>[ RADIATION OVERLOAD → AUTO-BAN LOG ]</b>\nเซกเตอร์: <code>${targetGroupId}</code> (${groupName})\nเป้าหมาย: <code>${targetUserId}</code> (${targetName})\nสาเหตุ: ${reason}\nสถานะ: Warn ครบ ${WARN_LIMIT} ครั้ง → แบนอัตโนมัติ`,
            { parse_mode: 'HTML' }
          );
          bot.sendMessage(msg.chat.id, `☢️ <b>รังสีพิษเกินขีดจำกัด! เป้าหมายถูกแบนอัตโนมัติ (${WARN_LIMIT}/${WARN_LIMIT})</b>`, { parse_mode: 'HTML' });

        } else {
          // ⚠️ ยังไม่ครบลิมิต → แจ้งเตือนในกลุ่ม
          apiCounter += 3;
          const remaining = WARN_LIMIT - currentWarn;

          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ แจ้งเตือนการปนเปื้อนรังสี - BIOHAZARD WARNING ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n\n🧬 <b>สัญญาณชีวภาพเป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n\n☢️ <b>ระดับรังสีสะสม:</b> [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ <b>สาเหตุการปนเปื้อน:</b> <code>${reason}</code>\n\n🚨 <b>คำเตือน:</b> หากรับรังสีเพิ่มอีก <b>${remaining} ครั้ง</b> ร่างกายจะระเบิดและถูกขับออกนอกชั้นบรรยากาศโดยอัตโนมัติ\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>ข้อความนี้จะระเหยสลายใน 60 วินาที...</i>`,
            { parse_mode: 'HTML' }
          );

          setTimeout(() => { apiCounter++; bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          await bot.sendMessage(LOG_CHANNEL_ID,
            `📜 <b>[ RADIATION INJECTION LOG ]</b>\nเซกเตอร์: <code>${targetGroupId}</code> (${groupName})\nเป้าหมาย: <code>${targetUserId}</code> (${targetName})\nรังสีสะสม: ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}`,
            { parse_mode: 'HTML' }
          );
          bot.sendMessage(msg.chat.id, `☢️ <b>ฉีดรังสีพิษสำเร็จ! ระดับปัจจุบัน ${currentWarn}/${WARN_LIMIT} (เหลืออีก ${remaining} ครั้งถึงระเบิด)</b>`, { parse_mode: 'HTML' });
        }
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ระบบฉีดรังสีขัดข้อง:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // ==========================================
    // 🧬 โหมดล้างพิษดีเอ็นเอ (DNA Detox / Unwarn)
    // ==========================================
    if (promptText.includes('[DNA DETOX PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;

      const spaceIdx = msg.text.trim().indexOf(' ');
      const targetInput = spaceIdx === -1 ? msg.text.trim() : msg.text.trim().substring(0, spaceIdx);
      const reason = spaceIdx === -1 ? 'ได้รับการล้างพิษจากศูนย์ควบคุมยานแม่' : msg.text.trim().substring(spaceIdx + 1).trim() || 'ได้รับการล้างพิษจากศูนย์ควบคุมยานแม่';

      const resolved = await resolveTarget(targetInput, bot);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name;

      const prevWarn = getWarnCount(targetGroupId, targetUserId);
      if (prevWarn === 0) {
        apiCounter++;
        return bot.sendMessage(msg.chat.id, `🧬 <b>ตรวจไม่พบรังสีสะสมในร่างกายของเป้าหมาย DNA สะอาดบริสุทธิ์อยู่แล้ว</b>`, { parse_mode: 'HTML' });
      }

      const newWarn = removeWarn(targetGroupId, targetUserId);
      const warnBar = buildWarnBar(newWarn, WARN_LIMIT);

      try {
        apiCounter += 3;
        const m = await bot.sendMessage(targetGroupId,
          `🧬 <b>[ แจ้งเตือนการล้างพิษดีเอ็นเอ - DNA DETOX COMPLETE ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n\n🧬 <b>สัญญาณชีวภาพเป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n\n☢️ <b>ระดับรังสีหลังล้างพิษ:</b> [${warnBar}] ${newWarn}/${WARN_LIMIT}\n💉 <b>หมายเหตุ:</b> <code>${reason}</code>\n\n✅ <b>สถานะ:</b> รังสีพิษถูกขับออกจากเนื้อเยื่อ 1 ชั้น ระบบชีวภาพกลับสู่สภาวะเสถียร\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>ข้อความนี้จะระเหยสลายใน 60 วินาที...</i>`,
          { parse_mode: 'HTML' }
        );

        setTimeout(() => { apiCounter++; bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        await bot.sendMessage(LOG_CHANNEL_ID,
          `📜 <b>[ DNA DETOX LOG ]</b>\nเซกเตอร์: <code>${targetGroupId}</code> (${groupName})\nเป้าหมาย: <code>${targetUserId}</code> (${targetName})\nรังสีก่อนล้าง: ${prevWarn} → หลังล้าง: ${newWarn}\nหมายเหตุ: ${reason}`,
          { parse_mode: 'HTML' }
        );
        bot.sendMessage(msg.chat.id, `🧬 <b>ล้างพิษสำเร็จ! ระดับรังสีลดลงเหลือ ${newWarn}/${WARN_LIMIT}</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ระบบล้างพิษขัดข้อง:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // ==========================================
    // 🔬 โหมดสแกนระดับรังสี (Radiation Scanner / Warn Check)
    // ==========================================
    if (promptText.includes('[RADIATION SCANNER]')) {
      if (!msg.text) return;
      apiCounter++;

      const targetInput = msg.text.trim().split(' ')[0];

      const resolved = await resolveTarget(targetInput, bot);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name;

      apiCounter++;
      const currentWarn = getWarnCount(targetGroupId, targetUserId);
      const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);
      const statusText = currentWarn === 0
        ? '✅ DNA บริสุทธิ์ ไม่พบการปนเปื้อนรังสี'
        : currentWarn >= WARN_LIMIT
          ? '🚨 ระดับวิกฤต! อยู่ในขั้นถูกขับออกนอกชั้นบรรยากาศ'
          : `⚠️ ตรวจพบรังสีสะสม — อีก ${WARN_LIMIT - currentWarn} ครั้งจะระเบิด`;

      bot.sendMessage(msg.chat.id,
        `🔬 <b>[ RADIATION SCAN REPORT ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>เป้าหมาย:</b> ${targetName}\n🆔 <b>รหัสพันธุกรรม:</b> <code>${targetUserId}</code>\n🛰️ <b>เซกเตอร์:</b> ${groupName}\n\n☢️ <b>ระดับรังสีสะสม:</b> [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n\n📡 <b>สถานะชีวภาพ:</b> ${statusText}\n━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // ==========================================
    // 💬 โหมดส่งข้อความตอบกลับผ่านลิงก์ (Reply Link System)
    // ==========================================
    if (promptText.includes('[REPLY LINK PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;
      try {
        const inputStr = msg.text.trim();
        const spaceIndex = inputStr.indexOf(' ');
        if (spaceIndex === -1) throw new Error("ตรวจพบข้อผิดพลาด: โปรดเคาะเว้นวรรคหลังลิงก์แล้วตามด้วยข้อความที่จะใช้ตอบกลับ");

        const url = inputStr.substring(0, spaceIndex).trim();
        const replyText = inputStr.substring(spaceIndex).trim();

        let targetChatId;
        let messageId;

        if (url.includes('/c/')) {
          const parts = url.split('/');
          messageId = parseInt(parts.pop());
          const chatIdStr = parts.pop();
          targetChatId = parseInt("-100" + chatIdStr);
        } else {
          const parts = url.split('/');
          messageId = parseInt(parts.pop());
          const username = parts.pop();
          targetChatId = "@" + username;
        }

        if (!targetChatId || isNaN(messageId)) throw new Error("รูปแบบพิกัดข้อความไม่สมบูรณ์");

        apiCounter += 2;
        await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: messageId });
        bot.sendMessage(msg.chat.id, `📡 <b>ส่งคลื่นสัญญานตอบกลับแบบเนทีฟไปยังข้อความลิงก์เป้าหมายเสร็จสิ้น!</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ <b>ปฏิบัติการขัดข้อง:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // ==========================================
    // 🔴 โหมดแบนดีเอ็นเอ (Vaporize System)
    // ==========================================
    if (promptText.includes('[VAPORIZE PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;

      const spaceIdx = msg.text.trim().indexOf(' ');
      const targetInput = spaceIdx === -1 ? msg.text.trim() : msg.text.trim().substring(0, spaceIdx);
      const reason = spaceIdx === -1 ? 'ตรวจพบการขัดขวางและต่อต้านกองทัพเอเลี่ยน' : msg.text.trim().substring(spaceIdx + 1).trim() || 'ตรวจพบการขัดขวางและต่อต้านกองทัพเอเลี่ยน';

      const resolved = await resolveTarget(targetInput, bot);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name;

      try {
        apiCounter += 2;
        await bot.banChatMember(targetGroupId, targetUserId);
        clearWarn(targetGroupId, targetUserId); // ล้าง warn ด้วยเมื่อแบน
        
        const m = await bot.sendMessage(targetGroupId, `🔴 <b>[ แจ้งเตือนการล้างเผ่าพันธุ์ - BAN VAPORIZED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n👤 <b>เป้าหมายที่ถูกทำลาย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🚨 <b>ข้อหาการกระทำผิด:</b> <code>${reason}</code>\n🛸 <b>สถานะปัจจุบัน:</b> ถูกระเหยสลายตัวตนและขับไล่ออกนอกชั้นบรรยากาศ (Vaporized)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ VAPORIZATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code> (${groupName})\nเหยื่อถูกทำลาย: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>ลบเผ่าพันธุ์เป้าหมายและบันทึกประวัติลงคลังข้อมูลแล้ว</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ขัดข้อง: เป้าหมายมีเกาะกำบังหนาแน่นหรือระบบขาดสิทธิ์แอดมินล้างบาง</b>\n<code>ข้อมูล: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // ==========================================
    // 🟢 โหมดปลดแบนดีเอ็นเอ (Reanimate System)
    // ==========================================
    if (promptText.includes('[REANIMATE PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;

      const spaceIdx = msg.text.trim().indexOf(' ');
      const targetInput = spaceIdx === -1 ? msg.text.trim() : msg.text.trim().substring(0, spaceIdx);
      const reason = spaceIdx === -1 ? 'ได้รับการอภัยโทษสูงสุดจากยานแม่เอเลี่ยน' : msg.text.trim().substring(spaceIdx + 1).trim() || 'ได้รับการอภัยโทษสูงสุดจากยานแม่เอเลี่ยน';

      const resolved = await resolveTarget(targetInput, bot);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name;

      try {
        apiCounter += 2;
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        
        const m = await bot.sendMessage(targetGroupId, `🟢 <b>[ แจ้งเตือนการฟื้นฟูชีพ - UNBAN REANIMATED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n👤 <b>เป้าหมายที่ได้รับอภัย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🔓 <b>สถานะปัจจุบัน:</b> ได้รับการสร้างเนื้อเยื่อจำลองและอนุญาตให้ผ่านเข้าชั้นบรรยากาศใหม่อีกครั้ง (Access Granted)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ REANIMATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code> (${groupName})\nเป้าหมายคืนชีพ: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>ปฏิรูปโมเลกุลชุบชีวิตเนื้อเยื่อและเปิดด่านผ่านชั้นบรรยากาศสำเร็จ</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ขัดข้อง: ไม่สามารถแก้ไขรหัส DNA ของเป้าหมายในเซกเตอร์กลุ่มได้</b>\n<code>ข้อมูล: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // ==========================================
    // 📡 โหมดประกาศคลื่นประสาท (Beam Transmission System)
    // ==========================================
    if (promptText.includes('[BEAM TRANSMISSION]')) {
      apiCounter += 2;
      try {
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        bot.sendMessage(msg.chat.id, `📡 <b>คลื่นสัญญาณถูกบีมแทรกซึมเข้าเน็ตเวิร์กเซกเตอร์กลุ่มเรียบร้อย ข้อมูลโทรมาตรถูกทำลายเกลี้ยง ล็อกดาวน์ไร้ประวัติสืบค้น</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ <b>คลื่นความถี่พลังงานหักล้างทำลายส่งสัญญาณไม่สำเร็จ:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
  }
});

// เปิดพอร์ตเชื่อมกับเว็บเซิร์ฟเวอร์เพื่อให้ Render ไม่ปิดระบบบอท
http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
