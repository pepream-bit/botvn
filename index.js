const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

// 🌌 ระบบฐานข้อมูลดีเอ็นเอชั่วคราว (เก็บคีย์ Username แปลงเป็น ID และเก็บชื่อเล่น)
const usernameCache = {};

// ☢️ ระบบฐานข้อมูลคำเตือนรังสีพิษ (warnData[groupId][userId] = จำนวนครั้ง)
let warnData = {};
const WARN_LIMIT = 2;

// 🔋 ระบบตรวจวัดการเรียกใช้งาน API ป้องกันการถูกระงับสัญญาณ
let apiCounter = 0;
const API_DAILY_MAX = 50000;

// 📅 ระบบ Persistent Daily Storage (รีเซตรายวัน ไม่รีเซตตอน restart)
const fs = require('fs');
const STORAGE_FILE = './daily_data.json';

function getTodayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function loadDailyData() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.date === getTodayDate()) {
        apiCounter = data.apiCounter || 0;
        warnData = data.warnData || {};
        console.log(`📂 โหลดข้อมูลวันนี้ (${data.date}): API=${apiCounter}, Warns loaded`);
        return;
      }
    }
  } catch (e) {}
  // วันใหม่หรือไม่มีไฟล์ → รีเซต
  apiCounter = 0;
  warnData = {};
  saveDailyData();
  console.log(`🔄 รีเซตข้อมูลรายวัน (${getTodayDate()})`);
}

function saveDailyData() {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify({
      date: getTodayDate(),
      apiCounter,
      warnData
    }));
  } catch (e) {
    console.error('❌ บันทึกข้อมูลไม่สำเร็จ:', e.message);
  }
}

// โหลดข้อมูลตอนเริ่มระบบ
loadDailyData();

// ตั้ง Timer รีเซตอัตโนมัติทุกเที่ยงคืน
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - now;
  setTimeout(() => {
    apiCounter = 0;
    warnData = {};
    saveDailyData();
    console.log(`🔄 รีเซตรายวันอัตโนมัติ (${getTodayDate()})`);
    scheduleMidnightReset();
  }, msUntilMidnight);
}
scheduleMidnightReset();

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
// 🔧 ฟังก์ชัน resolve เป้าหมาย → { userId, name, error }
// รองรับ: @username | ตัวเลข ID
// ==========================================
function resolveTarget(input) {
  const trimmed = input.trim();

  // --- รูปแบบ @username ---
  if (trimmed.startsWith('@')) {
    const key = trimmed.replace('@', '').toLowerCase();
    if (usernameCache[key]) return { userId: usernameCache[key].id, name: usernameCache[key].name };
    return { error: `❌ ไม่พบ ID ของ <code>${trimmed}</code> ในระบบ\n💡 ให้เป้าหมายส่งข้อความในกลุ่มก่อน หรือใส่ตัวเลข ID แทน` };
  }

  // --- รูปแบบ ตัวเลข ID ---
  const userId = parseInt(trimmed);
  if (isNaN(userId)) {
    return { error: '❌ รูปแบบไม่ถูกต้อง ใช้ <code>@username</code> หรือ <code>ตัวเลข ID</code>' };
  }
  let name = null;
  for (const key in usernameCache) {
    if (usernameCache[key].id === userId) { name = usernameCache[key].name; break; }
  }
  return { userId, name }; // name อาจเป็น null → จะดึงจาก Telegram ทีหลัง
}

// ดึงชื่อจาก cache หรือ Telegram API (fallback)
async function resolveName(userId, groupId) {
  // ค้นหาจาก id key ก่อน
  if (usernameCache[`id_${userId}`]) return usernameCache[`id_${userId}`].name;
  // ค้นหาจาก username key
  for (const key in usernameCache) {
    if (usernameCache[key].id === userId) return usernameCache[key].name;
  }
  // fallback: ดึงจาก Telegram API
  try {
    apiCounter++;
    const member = await bot.getChatMember(groupId, userId);
    const u = member.user;
    const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username || `ID:${userId}`;
    usernameCache[`id_${userId}`] = { id: userId, name };
    if (u.username) usernameCache[u.username.toLowerCase()] = { id: userId, name };
    return name;
  } catch (e) {
    return `ID:${userId}`;
  }
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
      bot.sendMessage(chatId, `🔴 <b>[VAPORIZE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุเหยื่อที่จะล้างบาง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unban') {
      bot.sendMessage(chatId, `🟢 <b>[REANIMATE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุดีเอ็นเอที่จะชุบชีวิตกลับมา:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'warn') {
      bot.sendMessage(chatId, `☢️ <b>[RADIATION INJECTION PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่จะฉีดรังสีพิษ (ครบ ${WARN_LIMIT} ครั้ง = แบนอัตโนมัติ):\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unwarn') {
      bot.sendMessage(chatId, `🧬 <b>[DNA DETOX PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่จะถอนรังสีพิษออก 1 ครั้ง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'warncheck') {
      bot.sendMessage(chatId, `🔬 <b>[RADIATION SCANNER] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่ต้องการสแกนระดับรังสีสะสม:\nรูปแบบ: <code>@username</code> หรือ <code>รหัสตัวเลข ID</code>`, {
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
  if (msg.from) {
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
    const idKey = `id_${msg.from.id}`;
    usernameCache[idKey] = { id: msg.from.id, name: fullName };
    if (msg.from.username) {
      const usernameKey = msg.from.username.toLowerCase().replace('@', '');
      usernameCache[usernameKey] = { id: msg.from.id, name: fullName };
    }
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
        bot.sendMessage(msg.from.id, '🛸 ดึงสื่อสำเร็จ ส่งเข้าแชทส่วนตัวแล้ว', { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.from.id, `❌ ดึงสื่อไม่สำเร็จ: <code>${e.message}</code>`, { parse_mode: 'HTML' });
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

      const resolved = resolveTarget(targetInput);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      try {
        const currentWarn = addWarn(targetGroupId, targetUserId);
        saveDailyData();
        const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);

        if (currentWarn >= WARN_LIMIT) {
          // ☢️ ครบลิมิต → แบนอัตโนมัติ
          apiCounter += 3;
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId);
          saveDailyData();

          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ RADIATION OVERLOAD - AUTO BAN ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a> (<code>${targetUserId}</code>)\n☢️ รังสี: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n💥 สาเหตุ: <code>${reason}</code>\n☠️ ถูกขับออกนอกชั้นบรรยากาศ (AUTO-BAN)\n⏰ <i>ระเหยใน 60 วิ...</i>`,
            { parse_mode: 'HTML' }
          );

          setTimeout(() => { apiCounter++; bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          apiCounter += 2;
          await bot.sendMessage(LOG_CHANNEL_ID,
            `📜 <b>[ AUTO-BAN LOG ]</b>\nกลุ่ม: ${groupName} (<code>${targetGroupId}</code>)\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>)\nสาเหตุ: ${reason} | Warn ครบ ${WARN_LIMIT}`,
            { parse_mode: 'HTML' }
          );
          bot.sendMessage(msg.chat.id, `☢️ Warn ครบ ${WARN_LIMIT}/${WARN_LIMIT} — แบนอัตโนมัติแล้ว`, { parse_mode: 'HTML' });

        } else {
          // ⚠️ ยังไม่ครบลิมิต → แจ้งเตือนในกลุ่ม
          apiCounter += 3;
          const remaining = WARN_LIMIT - currentWarn;

          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a> (<code>${targetUserId}</code>)\n☢️ รังสี: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ สาเหตุ: <code>${reason}</code>\n🚨 อีก <b>${remaining} ครั้ง</b> จะถูกแบนอัตโนมัติ\n⏰ <i>ระเหยใน 60 วิ...</i>`,
            { parse_mode: 'HTML' }
          );

          setTimeout(() => { apiCounter++; bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          await bot.sendMessage(LOG_CHANNEL_ID,
            `📜 <b>[ WARN LOG ]</b>\nกลุ่ม: ${groupName} (<code>${targetGroupId}</code>)\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>) | ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}`,
            { parse_mode: 'HTML' }
          );
          bot.sendMessage(msg.chat.id, `☢️ Warn สำเร็จ ${currentWarn}/${WARN_LIMIT} (เหลืออีก ${remaining} ครั้ง)`, { parse_mode: 'HTML' });
        }
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ ระบบ Warn ขัดข้อง: <code>${e.message}</code>`, { parse_mode: 'HTML' });
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

      const resolved = resolveTarget(targetInput);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      const prevWarn = getWarnCount(targetGroupId, targetUserId);
      if (prevWarn === 0) {
        apiCounter++;
        return bot.sendMessage(msg.chat.id, `🧬 เป้าหมายไม่มี Warn อยู่แล้ว`, { parse_mode: 'HTML' });
      }

      const newWarn = removeWarn(targetGroupId, targetUserId);
      saveDailyData();
      const warnBar = buildWarnBar(newWarn, WARN_LIMIT);

      try {
        apiCounter += 3;
        const m = await bot.sendMessage(targetGroupId,
          `🧬 <b>[ DNA DETOX COMPLETE ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a> (<code>${targetUserId}</code>)\n☢️ รังสีหลังล้าง: [${warnBar}] ${newWarn}/${WARN_LIMIT}\n💉 หมายเหตุ: <code>${reason}</code>\n⏰ <i>ระเหยใน 60 วิ...</i>`,
          { parse_mode: 'HTML' }
        );

        setTimeout(() => { apiCounter++; bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        await bot.sendMessage(LOG_CHANNEL_ID,
          `📜 <b>[ UNWARN LOG ]</b>\nกลุ่ม: ${groupName} (<code>${targetGroupId}</code>)\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>) | ${prevWarn} → ${newWarn}\nหมายเหตุ: ${reason}`,
          { parse_mode: 'HTML' }
        );
        bot.sendMessage(msg.chat.id, `🧬 Unwarn สำเร็จ! รังสีเหลือ ${newWarn}/${WARN_LIMIT}`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ Unwarn ขัดข้อง: <code>${e.message}</code>`, { parse_mode: 'HTML' });
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

      const resolved = resolveTarget(targetInput);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      apiCounter++;
      const currentWarn = getWarnCount(targetGroupId, targetUserId);
      const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);
      const statusText = currentWarn === 0
        ? '✅ ไม่พบรังสีสะสม'
        : currentWarn >= WARN_LIMIT
          ? '🚨 ระดับวิกฤต! อยู่ในขั้นถูกแบน'
          : `⚠️ มีรังสีสะสม — อีก ${WARN_LIMIT - currentWarn} ครั้งจะถูกแบน`;

      bot.sendMessage(msg.chat.id,
        `🔬 <b>[ RADIATION SCAN ]</b>\n👤 ${targetName} (<code>${targetUserId}</code>)\n🛰️ กลุ่ม: ${groupName}\n☢️ รังสี: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n📡 สถานะ: ${statusText}`,
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
        bot.sendMessage(msg.chat.id, `📡 ตอบกลับข้อความสำเร็จ`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ ตอบกลับไม่สำเร็จ: <code>${e.message}</code>`, { parse_mode: 'HTML' });
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

      const resolved = resolveTarget(targetInput);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      try {
        apiCounter += 2;
        await bot.banChatMember(targetGroupId, targetUserId);
        clearWarn(targetGroupId, targetUserId); // ล้าง warn ด้วยเมื่อแบน
        saveDailyData();
        
        const m = await bot.sendMessage(targetGroupId, `🔴 <b>[ BAN VAPORIZED ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (<code>${targetUserId}</code>)\n🚨 สาเหตุ: <code>${reason}</code>\n🛸 ถูกขับออกนอกชั้นบรรยากาศ (Vaporized)\n⏰ <i>ระเหยใน 60 วิ...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ BAN LOG ]</b>\nกลุ่ม: ${groupName} (<code>${targetGroupId}</code>)\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>)\nสาเหตุ: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ แบนและบันทึก Log สำเร็จ`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ แบนไม่สำเร็จ (ขาดสิทธิ์แอดมิน?): <code>${e.message}</code>`, { parse_mode: 'HTML' });
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

      const resolved = resolveTarget(targetInput);
      if (resolved.error) { apiCounter++; return bot.sendMessage(msg.chat.id, resolved.error, { parse_mode: 'HTML' }); }
      let targetUserId = resolved.userId;
      let targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      try {
        apiCounter += 2;
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        
        const m = await bot.sendMessage(targetGroupId, `🟢 <b>[ UNBAN REANIMATED ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (<code>${targetUserId}</code>)\n🔓 ได้รับอนุญาตให้กลับเข้ากลุ่มได้อีกครั้ง\n⏰ <i>ระเหยใน 60 วิ...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ UNBAN LOG ]</b>\nกลุ่ม: ${groupName} (<code>${targetGroupId}</code>)\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>)\nสาเหตุ: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ ปลดแบนสำเร็จ`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ ปลดแบนไม่สำเร็จ: <code>${e.message}</code>`, { parse_mode: 'HTML' });
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
        bot.sendMessage(msg.chat.id, `📡 ส่งข้อความเข้ากลุ่มสำเร็จ`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ ส่งไม่สำเร็จ: <code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
  }
});

// เปิดพอร์ตเชื่อมกับเว็บเซิร์ฟเวอร์เพื่อให้ Render ไม่ปิดระบบบอท
http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
