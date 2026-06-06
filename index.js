const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// ==========================================
// 🛡️ระบบตั้งค่าความปลอดภัยจาก Render Environment
// ==========================================
const token = process.env.BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID 
  ? (isNaN(process.env.LOG_CHANNEL_ID) ? process.env.LOG_CHANNEL_ID.trim() : parseInt(process.env.LOG_CHANNEL_ID.trim())) 
  : null;

if (!token || !LOG_CHANNEL_ID || !mongoUri) {
  console.error('❌ CRITICAL ERROR: Environment Variables missing (Token, Log ID, or MongoDB URI)!');
  process.exit(1);
}

mongoose.connect(mongoUri)
  .then(() => console.log('💽 Nebula Database Connected! ระบบหน่วยความจำระยะยาวทำงานสมบูรณ์'))
  .catch(err => {
    console.error('❌ ฐานข้อมูลเชื่อมต่อล้มเหลว:', err.message);
    process.exit(1);
  });

const SystemDataSchema = new mongoose.Schema({
  date: String,
  apiCounter: { type: Number, default: 0 },
  warnData: { type: Object, default: {} }
}, { minimize: false }); 

const SystemData = mongoose.model('SystemData', SystemDataSchema);

const usernameCache = {};

// 👻 สถานะระบบ StoryBan แยกตามกลุ่ม (True = เปิด, False = ปิด)
const storyBanStatus = {};

// ⚙️ ตั้งค่าแยกตามกลุ่ม เช่น เวลาลบข้อความอัตโนมัติ
const botSettings = {}; // { groupId: { deleteTime: ms } }

function getDeleteTime(groupId) {
  return (botSettings[groupId] && botSettings[groupId].deleteTime !== undefined)
    ? botSettings[groupId].deleteTime
    : 60000; // default 60 วินาที
}

let warnData = {};
const WARN_LIMIT = 2;
let apiCounter = 0;
const API_DAILY_MAX = 50000;

const monitorSessions = new Map();

function getTodayDate() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(now);
}

function getThailandTimestamp() {
  return new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

function getMsUntilThailandMidnight() {
  const now = new Date();
  const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const bangkokMidnight = new Date(bangkokTime);
  bangkokMidnight.setHours(24, 0, 0, 0);
  return bangkokMidnight - bangkokTime;
}

async function loadDailyData() {
  try {
    let data = await SystemData.findOne({ date: getTodayDate() });
    if (data) {
      apiCounter = data.apiCounter || 0;
      warnData = data.warnData || {};
      console.log(`📂 โหลดข้อมูลวันนี้สำเร็จ (${getTodayDate()})`);
    } else {
      apiCounter = 0;
      warnData = {};
      await saveDailyData();
      console.log(`🔄 สร้างชุดข้อมูลใหม่สำหรับวันนี้ (${getTodayDate()})`);
    }
  } catch (e) {
    console.error('❌ โหลดข้อมูลล้มเหลว:', e.message);
  }
}

async function saveDailyData() {
  try {
    await SystemData.findOneAndUpdate(
      { date: getTodayDate() },
      { apiCounter, warnData },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error('❌ บันทึกข้อมูลคลาวด์ล้มเหลว:', e.message);
  }
}

loadDailyData();

function scheduleMidnightReset() {
  const msUntilMidnight = getMsUntilThailandMidnight();
  setTimeout(async () => {
    apiCounter = 0;
    warnData = {};
    await saveDailyData();
    console.log(`🔄 รีเซตค่ารายวันอัตโนมัติเรียบร้อย (${getTodayDate()})`);
    scheduleMidnightReset();
  }, msUntilMidnight);
}
scheduleMidnightReset();

const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) {
      TARGET_GROUPS.push({ id: parseInt(parts[0].trim()), name: parts.slice(1).join(':').trim() });
    }
  });
}

if (WHITELIST_IDS.length === 0 || TARGET_GROUPS.length === 0) {
  console.error('❌ CRITICAL ERROR: Whitelist หรือ Target Groups ไม่ถูกต้อง!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log('🛸 บอท Alien Invasion พร้อมลุยในอวกาศแล้ว!');

// ==========================================
// 🔗 ฟังก์ชันช่วยสร้างลิงก์สำหรับกระโดดไปดูข้อความในกลุ่ม
// ==========================================
function buildMessageLink(chatId, messageId) {
  const strId = chatId.toString();
  if (strId.startsWith('-100')) {
    return `https://t.me/c/${strId.replace('-100', '')}/${messageId}`;
  } else if (strId.startsWith('@')) {
    return `https://t.me/${strId.replace('@', '')}/${messageId}`;
  }
  return null;
}

// ==========================================
// 📡 ฟังก์ชันสำหรับส่ง Log ไปยังแชนแนลอย่างปลอดภัย
// ==========================================
async function sendSystemLog(message) {
  if (!LOG_CHANNEL_ID) return;
  try {
    apiCounter++;
    await bot.sendMessage(LOG_CHANNEL_ID, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(`❌ ไม่สามารถส่งข่าวสารเข้า Log Channel ได้:`, err.message);
  }
}

// ==========================================
// 🔧 ฟังก์ชันระบบ Utility & การคำนวณ
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

function resolveTarget(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('@')) {
    const key = trimmed.replace('@', '').toLowerCase();
    if (usernameCache[key]) return { userId: usernameCache[key].id, name: usernameCache[key].name };
    return { error: `❌ ไม่พบ ID ของ <code>${trimmed}</code>\n💡 แนะนำให้เป้าหมายพิมพ์อะไรก็ได้ในกลุ่มสักคำ แล้วลองใหม่` };
  }
  const userId = parseInt(trimmed);
  if (isNaN(userId)) return { error: '❌ รูปแบบไม่ถูกต้อง กรุณาใช้ @username หรือ ตัวเลข ID เท่านั้น' };
  let name = null;
  for (const key in usernameCache) {
    if (usernameCache[key].id === userId) { name = usernameCache[key].name; break; }
  }
  return { userId, name };
}

async function resolveName(userId, groupId) {
  if (usernameCache[`id_${userId}`]) return usernameCache[`id_${userId}`].name;
  for (const key in usernameCache) {
    if (usernameCache[key].id === userId) return usernameCache[key].name;
  }
  try {
    apiCounter++;
    await saveDailyData();
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
// 📺 ระบบ UI เมนูหน้าจอ (จัดหมวดหมู่)
// ==========================================

// ลบข้อความเก่าก่อนส่งใหม่เสมอ (กันหน้าจอค้าง)
function sendMainMenu(chatId, messageId = null) {
  apiCounter++;
  saveDailyData();
  if (messageId) bot.deleteMessage(chatId, messageId).catch(()=>{});

  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);
  keyboard.push([
    { text: `📊 ตรวจสอบโควตา API`, callback_data: `view_api_limits` },
    { text: `👥 รายชื่อ Whitelist`, callback_data: `view_whitelist` }
  ]);
  keyboard.push([{ text: `❌ ปิดหน้าต่างแผงควบคุม (Close)`, callback_data: `close_main_menu` }]);

  bot.sendMessage(chatId, "🛸 <b>แผงควบคุมหลัก: กองทัพเอเลี่ยนต่างดาว (Alien Command)</b>\nโปรดเลือกเซกเตอร์ดาวเทียมที่คุณต้องการจัดการ:", {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  });
}

// เมนูหลักของแต่ละกลุ่ม (3 หมวด)
function sendGroupMenu(chatId, messageId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  if (messageId) bot.deleteMessage(chatId, messageId).catch(()=>{});

  const submenu = [
    [{ text: '🛡️ ระบบลงทัณฑ์ (Security)', callback_data: `menu_sec_${groupId}` }],
    [{ text: '📡 ระบบสื่อสาร (Comms)', callback_data: `menu_comms_${groupId}` }],
    [{ text: '⚙️ ตั้งค่าระบบ (Settings)', callback_data: `menu_set_${groupId}` }],
    [{ text: '⬅️ กลับหน้าจอหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId, `🛰️ <b>เซกเตอร์:</b> <code>${group.name}</code>\nโปรดเลือกหมวดหมู่คำสั่ง:`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

// เมนูหมวด Security (Ban/Warn/StoryBan)
function sendSecurityMenu(chatId, messageId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  if (messageId) bot.deleteMessage(chatId, messageId).catch(()=>{});

  const isStoryBanOn = storyBanStatus[groupId];
  const submenu = [
    [
      { text: '🔴 ล้างบางเผ่าพันธุ์ (Ban)', callback_data: `opt_ban_${groupId}` },
      { text: '🟢 ชุบชีวิตเนื้อเยื่อ (Unban)', callback_data: `opt_unban_${groupId}` }
    ],
    [
      { text: '☢️ ฉีดรังสีพิษ (Warn)', callback_data: `opt_warn_${groupId}` },
      { text: '🧬 ล้างพิษดีเอ็นเอ (Unwarn)', callback_data: `opt_unwarn_${groupId}` }
    ],
    [{ text: '🔬 สแกนระดับรังสี (Warn Status)', callback_data: `opt_warncheck_${groupId}` }],
    [{ text: isStoryBanOn ? '🟢 StoryBan: ON' : '🔴 StoryBan: OFF', callback_data: `toggle_storyban_${groupId}` }],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `🛡️ <b>ระบบลงทัณฑ์และความปลอดภัย</b>\n🛰️ เซกเตอร์: <code>${group.name}</code>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

// เมนูหมวด Comms (ประกาศ/Reply/Stealth/Jump)
function sendCommsMenu(chatId, messageId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  if (messageId) bot.deleteMessage(chatId, messageId).catch(()=>{});

  const submenu = [
    [
      { text: '🧲 ดูดสื่อไร้ร่องรอย (Stealth)', callback_data: `cmd_capture_url_${groupId}` },
      { text: '📡 ยิงคลื่นประกาศ (Transmit)', callback_data: `opt_ann_${groupId}` }
    ],
    [
      { text: '💬 ตอบกลับด้วยลิงก์ (Reply)', callback_data: `opt_replylink_${groupId}` },
      { text: '🚀 ทางลัดข้อความ (Jump)', callback_data: `opt_quickjump_${groupId}` }
    ],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `📡 <b>ระบบสื่อสารดาวเทียม</b>\n🛰️ เซกเตอร์: <code>${group.name}</code>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

// เมนูหมวด Settings (ตั้งเวลาลบข้อความ)
function sendSettingsMenu(chatId, messageId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  if (messageId) bot.deleteMessage(chatId, messageId).catch(()=>{});

  const currentVal = getDeleteTime(groupId);
  const textVal = currentVal === 0 ? '🛑 ไม่ลบ' : `${currentVal / 1000} วินาที`;
  const submenu = [
    [
      { text: '⏱️ 10 วิ', callback_data: `set_del_${groupId}_10000` },
      { text: '⏱️ 30 วิ', callback_data: `set_del_${groupId}_30000` }
    ],
    [
      { text: '⏱️ 60 วิ', callback_data: `set_del_${groupId}_60000` },
      { text: '🛑 ไม่ลบ', callback_data: `set_del_${groupId}_0` }
    ],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `⚙️ <b>ตั้งค่าระยะเวลาลบข้อความบอทอัตโนมัติ</b>\n🛰️ เซกเตอร์: <code>${group.name}</code>\nค่าปัจจุบัน: <code>${textVal}</code>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

// compat wrapper — ใช้แทน restoreSubmenu เดิมที่เรียกจาก session handler
function restoreSubmenu(chatId, messageId, groupId) {
  sendGroupMenu(chatId, messageId, groupId);
}

bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  monitorSessions.delete(msg.from.id);
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 🔘 ระบบประมวลผลปุ่มกด (Callback Query)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    apiCounter++;
    saveDailyData();
    return bot.answerCallbackQuery(query.id, { text: 'ปฏิเสธคำสั่ง! สัญญาณของคุณไม่อยู่ในระบบ Whitelist', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(()=>{});

  // ยกเลิกเซสชัน → กลับเมนูกลุ่ม
  if (data.startsWith('cancel_')) {
    const groupId = data.replace('cancel_', '');
    monitorSessions.delete(query.from.id);
    return sendGroupMenu(chatId, messageId, groupId);
  }

  // กลับหน้าจอหลัก
  if (data === 'back_to_main') {
    apiCounter += 2;
    saveDailyData();
    return sendMainMenu(chatId, messageId);
  }

  // ปิดหน้าต่าง
  if (data === 'close_main_menu') {
    apiCounter++;
    saveDailyData();
    return bot.deleteMessage(chatId, messageId).catch(()=>{});
  }

  // โควตา API
  if (data === 'view_api_limits') {
    apiCounter += 2;
    saveDailyData();
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
    const bars = Math.round(pct / 10);
    const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
    return bot.sendMessage(chatId, `📊 <b>เครื่องตรวจวัดขีดจำกัดสัญญาณ API รายวัน</b>\n\nแถบพลังงาน: [<code>${barStr}</code>] ${pct}%\nเรียกใช้งานไปแล้ว: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง\n\n⚠️ <i>ข้อมูลบันทึกถาวรผ่านระบบคลาวด์ปลอดภัย ไม่สูญหายเมื่อรีสตาร์ท (เวลาไทย)</i>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]] }
    });
  }

  // Whitelist
  if (data === 'view_whitelist') {
    apiCounter += 2;
    saveDailyData();
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    let listMsg = `👥 <b>รายชื่อโอเปอเรเตอร์ผู้ควบคุมระบบ (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ผู้ใช้นิรนาม";
      for (const key in usernameCache) {
        if (usernameCache[key].id === id) { name = usernameCache[key].name; break; }
      }
      listMsg += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    listMsg += `━━━━━━━━━━━━━━━━━━━━`;
    return bot.sendMessage(chatId, listMsg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]] }
    });
  }

  // เลือกกลุ่ม → เมนูหมวดหมู่
  if (data.startsWith('select_group_')) {
    apiCounter += 2;
    saveDailyData();
    return sendGroupMenu(chatId, messageId, data.replace('select_group_', ''));
  }

  // เมนูหมวด Security
  if (data.startsWith('menu_sec_')) {
    return sendSecurityMenu(chatId, messageId, data.replace('menu_sec_', ''));
  }

  // เมนูหมวด Comms
  if (data.startsWith('menu_comms_')) {
    return sendCommsMenu(chatId, messageId, data.replace('menu_comms_', ''));
  }

  // เมนูหมวด Settings
  if (data.startsWith('menu_set_')) {
    return sendSettingsMenu(chatId, messageId, data.replace('menu_set_', ''));
  }

  // ตั้งเวลาลบข้อความ
  if (data.startsWith('set_del_')) {
    const parts = data.split('_');
    const groupId = parts[2];
    const timeVal = parseInt(parts[3]);
    if (!botSettings[groupId]) botSettings[groupId] = {};
    botSettings[groupId].deleteTime = timeVal;
    bot.answerCallbackQuery(query.id, { text: `✅ อัปเดตเวลาลบข้อความสำเร็จ` }).catch(()=>{});
    return sendSettingsMenu(chatId, messageId, groupId);
  }

  // Toggle StoryBan
  if (data.startsWith('toggle_storyban_')) {
    const groupId = data.replace('toggle_storyban_', '');
    storyBanStatus[groupId] = !storyBanStatus[groupId];
    bot.answerCallbackQuery(query.id, { text: `อัปเดตระบบ StoryBan เป็น ${storyBanStatus[groupId] ? '🟢 ON' : '🔴 OFF'} เรียบร้อยแล้ว` }).catch(()=>{});
    return sendSecurityMenu(chatId, messageId, groupId);
  }

  // คำสั่งต่างๆ (opt_ / cmd_capture_url_)
  if (data.startsWith('opt_') || data.startsWith('cmd_capture_url_')) {
    apiCounter += 2;
    saveDailyData();
    let action, groupId;

    if (data.startsWith('cmd_capture_url_')) {
      action = 'capture_url';
      groupId = data.replace('cmd_capture_url_', '');
    } else {
      const parts = data.split('_');
      action = parts[1];
      groupId = parts[2];
    }

    let promptMsg = '';
    if (action === 'capture_url') promptMsg = `🧲 <b>[STEALTH CAPTURE] เซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์ข้อความ Telegram เพื่อดูดสื่อแบบไร้ร่องรอย (เช่น https://t.me/c/xxxx/xxxx):`;
    else if (action === 'ban') promptMsg = `🔴 <b>[BAN PROTOCOL] เซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่ต้องการล้างบาง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>ตัวเลข ID เหตุผล</code>`;
    else if (action === 'unban') promptMsg = `🟢 <b>[UNBAN PROTOCOL] เซกเตอร์:</b> <code>${groupId}</code>\nระบุโครงสร้างที่จะคืนชีพ:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>ตัวเลข ID เหตุผล</code>`;
    else if (action === 'warn') promptMsg = `☢️ <b>[RADIATION WARN] เซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายเพื่อฉีดรังสีเตือน (ครบ ${WARN_LIMIT} ครั้งโดนแบนทันที):\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>ตัวเลข ID เหตุผล</code>`;
    else if (action === 'unwarn') promptMsg = `🧬 <b>[DETOX UNWARN] เซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายเพื่อล้างค่าเตือนออก 1 ขั้น:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>ตัวเลข ID เหตุผล</code>`;
    else if (action === 'warncheck') promptMsg = `🔬 <b>[RADIATION SCANNER] เซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายเพื่อทำการสแกนประวัติรังสี:\nรูปแบบ: <code>@username</code> หรือ <code>ตัวเลข ID</code>`;
    else if (action === 'ann') promptMsg = `📡 <b>[BEAM TRANSMISSION] เซกเตอร์:</b> <code>${groupId}</code>\nส่งข้อความ รูปภาพ ไฟล์ หรือวิดีโอ ที่ต้องการส่งคลื่นประกาศไปยังกลุ่มเป้าหมายแบบเนทีฟ:`;
    else if (action === 'replylink') promptMsg = `💬 <b>[REPLY LINK PROTOCOL] เซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์ข้อความตามด้วยคำตอบกลับในกลุ่มเนทีฟ\nรูปแบบ: <code>[ลิงก์ข้อความ] [คำตอบกลับ]</code>`;
    else if (action === 'quickjump') promptMsg = `🚀 <b>[QUICK JUMP] เซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์ข้อความที่ต้องการสร้างปุ่มทางลัด:`;

    bot.deleteMessage(chatId, messageId).catch(()=>{});
    monitorSessions.set(query.from.id, { chatId, groupId, action });

    bot.sendMessage(chatId, promptMsg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิกและกลับเมนู', callback_data: `select_group_${groupId}` }]] }
    });
  }
});

// ==========================================
// 💬 ระบบรับข้อความคำสั่งและควบคุมเซสชัน (TV Mode)
// ==========================================
bot.on('message', async (msg) => {
  if (!msg.from) return;

  const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
  usernameCache[`id_${msg.from.id}`] = { id: msg.from.id, name: fullName };
  if (msg.from.username) {
    usernameCache[msg.from.username.toLowerCase().replace('@', '')] = { id: msg.from.id, name: fullName };
  }

  // 👻 [STORYBAN SYSTEM] ตรวจจับและ Ghost Ban ทันทีถ้าเปิดสวิตช์ไว้
  const isTargetGroup = TARGET_GROUPS.some(g => g.id === msg.chat.id);
  if (isTargetGroup && storyBanStatus[msg.chat.id] && !WHITELIST_IDS.includes(msg.from.id)) {
    if (msg.forward_from_chat || msg.forward_from || msg.story || msg.forward_date) {
      try {
        await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        await bot.banChatMember(msg.chat.id, msg.from.id).catch(() => {});
        await sendSystemLog(`👻 <b>[STORYBAN TRIGGERED]</b>\nดีดเป้าหมาย <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>) ออกจากเซกเตอร์ <code>${msg.chat.title || msg.chat.id}</code> เรียบร้อยแล้ว\n(ข้อหา: Forward/Story ขัดคำสั่งขณะเปิดโหมดรักษาความปลอดภัย)\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        return;
      } catch (e) {
        console.error("❌ StoryBan Error:", e.message);
      }
    }
  }

  // 🛡️ [ANTI-IMPERSONATION]
  if (isTargetGroup && !WHITELIST_IDS.includes(msg.from.id)) {
    const senderFullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.toLowerCase();
    const IMPERSONATOR_NAMES = process.env.IMPERSONATOR_NAMES ? process.env.IMPERSONATOR_NAMES.split(',').map(n => n.trim().toLowerCase()) : [];
    
    const isMijji = IMPERSONATOR_NAMES.some(bName => senderFullName.includes(bName));

    if (isMijji) {
      try {
        apiCounter += 2;
        await saveDailyData();
        await bot.banChatMember(msg.chat.id, msg.from.id);
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        await sendSystemLog(`🚫 <b>[ANTI-IMPERSONATION BAN]</b>\nพบมิจฉาชีพตั้งชื่อเลียนแบบระบบและพยายามสแปมกลุ่ม!\n👤 ชื่อที่ตรวจพบ: <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>)\n📍 เซกเตอร์กลุ่ม: <code>${msg.chat.title || msg.chat.id}</code>\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        return;
      } catch (e) {
        console.error("❌ ไม่สามารถประมวลผลการแบนชื่อมิจฉาชีพได้:", e.message);
      }
    }
  }

  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  const session = monitorSessions.get(msg.from.id);
  if (!session) return;

  const { chatId, groupId, action } = session;
  const targetGroupId = parseInt(groupId);
  const groupObj = TARGET_GROUPS.find(g => g.id === targetGroupId);
  const groupName = groupObj ? groupObj.name : 'ไม่ระบุกลุ่ม';
  const delTime = getDeleteTime(targetGroupId);
  
  const inputStr = msg.text ? msg.text.trim() : '';

  if (action !== 'ann') {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  }

  // helper ปุ่มกลับเมนูกลุ่ม
  const finishMenu = { inline_keyboard: [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]] };

  let targetInput = '';
  let reason = '';
  let spaceIdx = -1;
  let resolved, targetUserId, targetName;

  switch (action) {

    // ann — ประกาศเข้ากลุ่ม
    case 'ann': {
      apiCounter += 2;
      await saveDailyData();
      monitorSessions.delete(msg.from.id);
      try {
        const copiedMsg = await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, copiedMsg.message_id).catch(()=>{}); }, delTime);
        
        const msgLink = buildMessageLink(targetGroupId, copiedMsg.message_id);
        const inlineKey = [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]];
        if (msgLink) inlineKey.unshift([{ text: '📢 เปิดดูข้อความประกาศในเซกเตอร์', url: msgLink }]);

        bot.sendMessage(chatId, `📡 <b>ส่งสัญญาณประกาศไปยังเป้าหมายสำเร็จ!</b>`, { 
          parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKey }
        }).catch(()=>{});
      } catch (e) {
        bot.sendMessage(chatId, `❌ <b>ส่งประกาศล้มเหลว:</b> ${e.message}`, { 
          parse_mode: 'HTML', reply_markup: finishMenu
        }).catch(()=>{});
      }
      break;
    }

    // capture_url — ดูดสื่อแบบ stealth
    case 'capture_url': {
      apiCounter++;
      await saveDailyData();
      monitorSessions.delete(msg.from.id);
      const loadingMsg = await bot.sendMessage(chatId, `⏳ <b>[STEALTH CAPTURE]</b>\nกำลังดึงสัญญาณโครงข่ายไร้ร่องรอย... โปรดรอสักครู่`, { parse_mode: 'HTML' });

      try {
        let tChatId, mId;
        if (inputStr.includes('/c/')) {
          const parts = inputStr.split('/');
          mId = parseInt(parts.pop());
          tChatId = parseInt("-100" + parts.pop());
        } else {
          const parts = inputStr.split('/');
          mId = parseInt(parts.pop());
          tChatId = "@" + parts.pop();
        }
        if (!tChatId || isNaN(mId)) throw new Error("รูปแบบพิกัดห้องดาวเทียมไม่ถูกต้อง");
        
        apiCounter += 2;
        await saveDailyData();
        await bot.copyMessage(msg.from.id, tChatId, mId);
        
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        bot.sendMessage(chatId, `🛸 <b>ดึงสื่อสำเร็จ</b>\nส่งตรงไปยังกล่องรับสัญญาณส่วนตัวของคุณเรียบร้อย!`, { 
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🔗 เปิดดูพิกัดสื่อต้นทาง', url: inputStr }],
            [{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]
          ]}
        }).catch(()=>{});
      } catch (e) {
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        bot.sendMessage(chatId, `❌ <b>เกิดข้อผิดพลาดในการดึงสื่อ:</b> <code>${e.message}</code>`, { 
          parse_mode: 'HTML', reply_markup: finishMenu
        }).catch(()=>{});
      }
      break;
    }

    // replylink — ตอบกลับข้อความในกลุ่ม
    case 'replylink': {
      apiCounter++;
      await saveDailyData();
      monitorSessions.delete(msg.from.id);
      try {
        spaceIdx = inputStr.indexOf(' ');
        if (spaceIdx === -1) throw new Error("โปรดใส่ข้อความเพื่อตอบกลับหลังเคาะเว้นวรรคลิงก์พิกัด");

        const url = inputStr.substring(0, spaceIdx).trim();
        const replyText = inputStr.substring(spaceIdx).trim();
        let tChatId, mId;

        if (url.includes('/c/')) {
          const parts = url.split('/');
          mId = parseInt(parts.pop());
          tChatId = parseInt("-100" + parts.pop());
        } else {
          const parts = url.split('/');
          mId = parseInt(parts.pop());
          tChatId = "@" + parts.pop();
        }
        if (!tChatId || isNaN(mId)) throw new Error("พิกัด URL ของสารข้อความไม่สมบูรณ์");

        apiCounter += 2;
        await saveDailyData();
        
        const sentMsg = await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, sentMsg.message_id).catch(()=>{}); }, delTime);
        const msgLink = buildMessageLink(targetGroupId, sentMsg.message_id);

        const inlineKey = [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]];
        if (msgLink) {
          inlineKey.unshift([{ text: '💬 เปิดดูข้อความตอบกลับของคุณ', url: msgLink }]);
        } else {
          inlineKey.unshift([{ text: '🔗 เปิดดูพิกัดต้นทาง', url: url }]);
        }

        bot.sendMessage(chatId, `📡 <b>ยิงคลื่นสารสัญญาณตอบกลับสำเร็จแล้ว!</b>`, { 
          parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKey }
        }).catch(()=>{});
      } catch (e) {
        bot.sendMessage(chatId, `❌ <b>ยิงสัญญาณสารล้มเหลว:</b> <code>${e.message}</code>`, { 
          parse_mode: 'HTML', reply_markup: finishMenu
        }).catch(()=>{});
      }
      break;
    }

    // quickjump — สร้างปุ่มทางลัดข้อความ
    case 'quickjump': {
      monitorSessions.delete(msg.from.id);
      bot.sendMessage(chatId, `✅ <b>สร้างทางลัดสำเร็จ!</b>`, { 
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🚀 พุ่งกระโดดไปยังพิกัด', url: inputStr }],
          [{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]
        ]}
      });
      break;
    }

    case 'warn':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ฝ่าฝืนกฎระเบียบกองทัพเอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) {
        monitorSessions.delete(msg.from.id);
        bot.sendMessage(chatId, `${resolved.error}`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        break;
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      try {
        const currentWarn = addWarn(targetGroupId, targetUserId);
        await saveDailyData();
        const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);

        if (currentWarn >= WARN_LIMIT) {
          apiCounter += 3;
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId);
          await saveDailyData();

          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ RADIATION OVERLOAD - AUTO BAN ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีสะสม: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n💥 เหตุผล: <code>${reason}</code>\n☠️ ปล่อยสลายนอกระบบอัตโนมัติ (AUTO-BAN)`,
            { parse_mode: 'HTML' }
          );
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

          await sendSystemLog(`📜 <b>[ AUTO-BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nสาเหตุ: ${reason} (Warn สะสมครบเกณฑ์)\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
          bot.sendMessage(chatId, `☢️ <b>รังสีสะสมเต็มขีดจำกัด! AUTO-BAN สำเร็จ</b>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        } else {
          apiCounter += 3;
          await saveDailyData();
          const rem = WARN_LIMIT - currentWarn;
          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีสะสม: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ เหตุผล: <code>${reason}</code>\n🚨 อีก <b>${rem} ครั้ง</b> จะถูกลบตัวตนออกจากโครงข่าย`,
            { parse_mode: 'HTML' }
          );
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

          await sendSystemLog(`📜 <b>[ WARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ระดับ: ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
          bot.sendMessage(chatId, `☢️ <b>ลงทัณฑ์รังสีสำเร็จ [${currentWarn}/${WARN_LIMIT}]</b>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        }
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>เกิดข้อผิดพลาดในการสั่ง Warn:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
      }
      break;

    case 'unwarn':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับอนุญาตล้างพิษจากยานแม่' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) {
        monitorSessions.delete(msg.from.id);
        bot.sendMessage(chatId, `${resolved.error}`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        break;
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      {
        const oldWarn = getWarnCount(targetGroupId, targetUserId);
        if (oldWarn === 0) {
          bot.sendMessage(chatId, `🧬 <b>เป้าหมายไม่มีค่ารังสีตกค้างอยู่แล้ว</b>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
          break;
        }

        const currentWarn = removeWarn(targetGroupId, targetUserId);
        await saveDailyData();
        const unwarnBar = buildWarnBar(currentWarn, WARN_LIMIT);

        try {
          apiCounter += 3;
          await saveDailyData();
          const m = await bot.sendMessage(targetGroupId,
            `🧬 <b>[ DETOXIFICATION COMPLETE ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ ระดับรังสีคงเหลือ: [${unwarnBar}] ${currentWarn}/${WARN_LIMIT}\n💉 บันทึกแพทย์: <code>${reason}</code>`,
            { parse_mode: 'HTML' }
          );
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

          await sendSystemLog(`📜 <b>[ UNWARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ค่าลดลง: ${oldWarn} → ${currentWarn}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
          bot.sendMessage(chatId, `🧬 <b>บำบัดดีเอ็นเอ Unwarn สำเร็จ!</b>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        } catch (e) {
          bot.sendMessage(chatId, `⚠️ <b>เกิดข้อผิดพลาดในการแก้สถานะ:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        }
      }
      break;

    case 'warncheck':
      apiCounter++;
      await saveDailyData();
      targetInput = inputStr.split(' ')[0];
      resolved = resolveTarget(targetInput);
      if (resolved.error) {
        monitorSessions.delete(msg.from.id);
        bot.sendMessage(chatId, `${resolved.error}`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        break;
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      {
        const checkWarn = getWarnCount(targetGroupId, targetUserId);
        const chkBar = buildWarnBar(checkWarn, WARN_LIMIT);
        const chkText = checkWarn === 0 ? '✅ คลื่นความถี่ปกติ ไม่มีสารพิษ' : checkWarn >= WARN_LIMIT ? '🚨 ระดับสีแดงวิกฤต (อยู่ภายใต้โปรโตคอลแบน)' : `⚠️ มีประวัติสะสมรังสี ควรรักษาความเงียบงัน`;

        bot.sendMessage(chatId, `🔬 <b>[ BIO-SCANNER MONITOR REPORT ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>ชื่อชีวภาพ:</b> ${targetName}\n🆔 <b>เลขโครงข่าย:</b> <code>${targetUserId}</code>\n🛰️ <b>เซกเตอร์ยึดครอง:</b> ${groupName}\n☢️ <b>ดัชนีรังสี:</b> [${chkBar}] ${checkWarn}/${WARN_LIMIT}\n📊 <b>สถานะวิเคราะห์:</b> ${chkText}\n━━━━━━━━━━━━━━━━━━━━`, {
          parse_mode: 'HTML', reply_markup: finishMenu
        }).catch(()=>{});
      }
      break;

    case 'ban':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ตรวจพบพฤติกรรมเป็นภัยต่อกองยานแม่' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) {
        monitorSessions.delete(msg.from.id);
        bot.sendMessage(chatId, `${resolved.error}`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        break;
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      try {
        apiCounter += 2;
        await bot.banChatMember(targetGroupId, targetUserId);
        clearWarn(targetGroupId, targetUserId);
        await saveDailyData();
        
        const m = await bot.sendMessage(targetGroupId, `🔴 <b>[ PROTOCOL VAPORIZED - BAN ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (🆔 <code>${targetUserId}</code>)\n🚨 ข้อหา: <code>${reason}</code>\n🛸 รหัสชีวภาพถูกลบพ้นวงโคจรอย่างถาวร`, { parse_mode: 'HTML' });
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

        await sendSystemLog(`📜 <b>[ EXECUTION BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nผู้สั่งการโจมตี: เจ้าหน้าที่ยานแม่\nข้อหา: ${reason}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        bot.sendMessage(chatId, `✅ <b>สลายตัวตนเป้าหมายสำเร็จ (Ban)</b>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>แบนล้มเหลว (บอทขาดสิทธิ์ผู้ดูแลกลุ่ม?):</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
      }
      break;

    case 'unban':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับการยกเว้นและอภัยโทษจากผู้ควบคุมยาน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) {
        monitorSessions.delete(msg.from.id);
        bot.sendMessage(chatId, `${resolved.error}`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
        break;
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      try {
        apiCounter += 2;
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        
        const m = await bot.sendMessage(targetGroupId, `🟢 <b>[ REANIMATE COMPLETE - UNBAN ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (🆔 <code>${targetUserId}</code>)\n🔓 อนุญาตให้ฟื้นคืนมวลสารกลับเข้าสู่พื้นที่`, { parse_mode: 'HTML' });
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

        await sendSystemLog(`📜 <b>[ UNBAN LOG ]</b>\nเซกเตอร์: ${groupName}\nคืนชีพเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nหมายเหตุ: ${reason}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        bot.sendMessage(chatId, `✅ <b>ฟื้นคืนเนื้อเยื่อสำเร็จ (Unban)</b>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>การปลดแบนขัดข้อง:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu }).catch(()=>{});
      }
      break;
  }
});

// 🌐 เปิดระบบรับสัญญาณพอร์ตเว็บเซิร์ฟเวอร์
http.createServer((req, res) => res.end('ALIEN_STATION_ONLINE')).listen(process.env.PORT || 3000);
