const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// ==========================================
// 🛡️ระบบตั้งค่าความปลอดภัยจาก Render Environment
// ==========================================
const token = process.env.BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;

// ปรับปรุงระบบตรวจสอบ LOG_CHANNEL_ID ให้ยืดหยุ่น รองรับทั้ง ตัวเลข ID และ @username แชนแนล
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID 
  ? (isNaN(process.env.LOG_CHANNEL_ID) ? process.env.LOG_CHANNEL_ID.trim() : parseInt(process.env.LOG_CHANNEL_ID.trim())) 
  : null;

if (!token || !LOG_CHANNEL_ID || !mongoUri) {
  console.error('❌ CRITICAL ERROR: Environment Variables missing (Token, Log ID, or MongoDB URI)!');
  process.exit(1);
}

// 💽 เชื่อมต่อโครงข่ายฐานข้อมูล MongoDB
mongoose.connect(mongoUri)
  .then(() => console.log('💽 Nebula Database Connected! ระบบหน่วยความจำระยะยาวทำงานสมบูรณ์'))
  .catch(err => {
    console.error('❌ ฐานข้อมูลเชื่อมต่อล้มเหลว:', err.message);
    process.exit(1);
  });

// กำหนดพิมพ์เขียวข้อมูล (Schema & Model)
const SystemDataSchema = new mongoose.Schema({
  date: String,
  apiCounter: { type: Number, default: 0 },
  warnData: { type: Object, default: {} }
}, { minimize: false }); 

const SystemData = mongoose.model('SystemData', SystemDataSchema);

// 🌌 หน่วยความจำแคช (เก็บชื่อเล่นและแปลง Username เป็น ID ชั่วคราว)
const usernameCache = {};

// ☢️ ข้อมูลคำเตือนและโควตา (Sync กับ MongoDB)
let warnData = {};
const WARN_LIMIT = 2;
let apiCounter = 0;
const API_DAILY_MAX = 50000;

// 🗂️ เซสชันควบคุมหน้าจอทีวีของโอเปอเรเตอร์
const monitorSessions = new Map();

// 🇹🇭 ฟังก์ชันจัดการเวลาประเทศไทย (Asia/Bangkok Zone)
function getTodayDate() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(now); // ส่งกลับค่าเป็น YYYY-MM-DD ตามเวลาไทยเป๊ะๆ
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

// 📂 ฟังก์ชันจัดการข้อมูลถาวรผ่าน Cloud
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

// โหลดข้อมูลทันทีเมื่อบอทเริ่มทำงาน
loadDailyData();

// ตั้งเวลารีเซตค่าทุกเที่ยงคืนเป๊ะ ตามเวลาประเทศไทย 🇹🇭
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

// 👥 แปลงรายชื่อระบบ Whitelist จาก Environment
const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

// 🛰️ แปลงกลุ่มเป้าหมาย (รูปแบบ ID:ชื่อ,ID:ชื่อ)
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
// 📡 ฟังก์ชันสำหรับส่ง Log ไปยังแชนแนลอย่างปลอดภัย
// ==========================================
async function sendSystemLog(message) {
  if (!LOG_CHANNEL_ID) return;
  try {
    apiCounter++;
    await bot.sendMessage(LOG_CHANNEL_ID, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(`❌ ไม่สามารถส่งข่าวสารเข้า Log Channel ได้ (กรุณาเช็กว่าบอทเป็น Admin ในแชนแนลหรือยัง):`, err.message);
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
// 📺 เมนูหน้าจอหลัก (Command Center TV)
// ==========================================
function sendMainMenu(chatId, messageId = null) {
  apiCounter++;
  saveDailyData();
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);

  keyboard.push([
    { text: `📊 ตรวจสอบโควตา API`, callback_data: `view_api_limits` },
    { text: `👥 รายชื่อ Whitelist`, callback_data: `view_whitelist` }
  ]);

  // 🛑 เพิ่มปุ่ม ปิดหน้าต่างแผงควบคุม
  keyboard.push([
    { text: `❌ ปิดหน้าต่างแผงควบคุม (Close)`, callback_data: `close_main_menu` }
  ]);

  const text = "🛸 <b>แผงควบคุมหลัก: กองทัพเอเลี่ยนต่างดาว (Alien Command)</b>\nโปรดเลือกเซกเตอร์ดาวเทียมที่คุณต้องการจัดการ:";
  const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options }).catch(()=>{});
  } else {
    bot.sendMessage(chatId, text, options);
  }
}

function restoreSubmenu(chatId, messageId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;

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
      { text: '⬅️ กลับสู่หน้าจอควบคุมหลัก', callback_data: 'back_to_main' }
    ]
  ];

  bot.editMessageText(`🛰️ <b>พิกัดเซกเตอร์ควบคุม:</b> <code>${group.name}</code>\nโปรดเลือกโปรโตคอลยิงคำสั่งสัญญาณ:`, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: submenu }
  }).catch(()=>{});
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

  if (data.startsWith('cancel_')) {
    const groupId = data.replace('cancel_', '');
    monitorSessions.delete(query.from.id);
    bot.answerCallbackQuery(query.id, { text: 'ยกเลิกโปรโตคอล' });
    return restoreSubmenu(chatId, messageId, groupId);
  }

  if (data === 'back_to_main') {
    apiCounter += 2;
    saveDailyData();
    sendMainMenu(chatId, messageId);
    return bot.answerCallbackQuery(query.id);
  }

  // 🛑 เพิ่มคำสั่ง ปิดหน้าต่างแผงควบคุม
  if (data === 'close_main_menu') {
    apiCounter++;
    saveDailyData();
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    return bot.answerCallbackQuery(query.id, { text: 'ปิดหน้าจอแผงควบคุมเรียบร้อย 🛸' });
  }

  if (data === 'view_api_limits') {
    apiCounter += 2;
    saveDailyData();
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
    const bars = Math.round(pct / 10);
    const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
    
    bot.editMessageText(`📊 <b>เครื่องตรวจวัดขีดจำกัดสัญญาณ API รายวัน</b>\n\nแถบพลังงาน: [<code>${barStr}</code>] ${pct}%\nเรียกใช้งานไปแล้ว: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง\n\n⚠️ <i>ข้อมูลบันทึกถาวรผ่านระบบคลาวด์ปลอดภัย ไม่สูญหายเมื่อรีสตาร์ท (เวลาไทย)</i>`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]] }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'view_whitelist') {
    apiCounter += 2;
    saveDailyData();
    let listMsg = `👥 <b>รายชื่อโอเปอเรเตอร์ผู้ควบคุมระบบ (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ผู้ใช้นิรนาม";
      for (const key in usernameCache) {
        if (usernameCache[key].id === id) { name = usernameCache[key].name; break; }
      }
      listMsg += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    listMsg += `━━━━━━━━━━━━━━━━━━━━`;
    
    bot.editMessageText(listMsg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]] }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('select_group_')) {
    apiCounter += 2;
    saveDailyData();
    const groupId = data.replace('select_group_', '');
    restoreSubmenu(chatId, messageId, groupId);
    return bot.answerCallbackQuery(query.id);
  }

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

    monitorSessions.set(query.from.id, { chatId, messageId, groupId, action });

    bot.editMessageText(promptMsg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิกและกลับเมนู', callback_data: `cancel_${groupId}` }]] }
    });
    return bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 💬 ระบบรับข้อความคำสั่งและควบคุมเซสชัน (TV Mode)
// ==========================================
bot.on('message', async (msg) => {
  if (!msg.from) return;

  // บันทึกและดึงข้อมูลชื่อจาก cache
  const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
  usernameCache[`id_${msg.from.id}`] = { id: msg.from.id, name: fullName };
  if (msg.from.username) {
    usernameCache[msg.from.username.toLowerCase().replace('@', '')] = { id: msg.from.id, name: fullName };
  }

  // 🛡️ [ANTI-IMPERSONATION] ระบบสแกนและแบนมิจฉาชีพที่ปลอมแปลงตั้งชื่อเหมือนกลุ่ม/ทีมงาน
  const isTargetGroup = TARGET_GROUPS.some(g => g.id === msg.chat.id);
  if (isTargetGroup && !WHITELIST_IDS.includes(msg.from.id)) {
    const senderFullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.toLowerCase();
    const IMPERSONATOR_NAMES = process.env.IMPERSONATOR_NAMES ? process.env.IMPERSONATOR_NAMES.split(',').map(n => n.trim().toLowerCase()) : [];
    
    // ตรวจสอบว่าชื่อผู้ส่งมีคำต้องห้ามหรือไม่
    const isMijji = IMPERSONATOR_NAMES.some(bName => senderFullName.includes(bName));

    if (isMijji) {
      try {
        apiCounter += 2;
        await saveDailyData();
        
        // ดีดมิจฉาชีพออกจากวงโคจรทันที
        await bot.banChatMember(msg.chat.id, msg.from.id);
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        
        // ส่งรายงานเข้า Channel พร้อมระบุเวลาไทยอย่างแม่นยำ
        await sendSystemLog(`🚫 <b>[ANTI-IMPERSONATION BAN]</b>\nพบมิจฉาชีพตั้งชื่อเลียนแบบระบบและพยายามสแปมกลุ่ม!\n👤 ชื่อที่ตรวจพบ: <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>)\n📍 เซกเตอร์กลุ่ม: <code>${msg.chat.title || msg.chat.id}</code>\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        
        return; // ทำลายโปรโตคอลข้อความนี้ทิ้งทันที
      } catch (e) {
        console.error("❌ ไม่สามารถประมวลผลการแบนชื่อมิจฉาชีพได้:", e.message);
      }
    }
  }

  // ระบบดั้งเดิม: กรองเฉพาะข้อความที่ส่งมาจาก Whitelist เพื่อควบคุมหน้าจอ Operator TV
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  const session = monitorSessions.get(msg.from.id);
  if (!session) return;

  const { chatId, messageId, groupId, action } = session;
  const targetGroupId = parseInt(groupId);
  const groupObj = TARGET_GROUPS.find(g => g.id === targetGroupId);
  const groupName = groupObj ? groupObj.name : 'ไม่ระบุกลุ่ม';
  
  const inputStr = msg.text ? msg.text.trim() : '';

  if (action !== 'ann') {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  }

  let targetInput = '';
  let reason = '';
  let spaceIdx = -1;
  let resolved, targetUserId, targetName;

  switch (action) {
    case 'ann':
      apiCounter += 2;
      await saveDailyData();
      monitorSessions.delete(msg.from.id);
      try {
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        bot.editMessageText(`📡 <b>ส่งสัญญาณประกาศไปยังเป้าหมายเนทีฟสำเร็จ!</b>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`❌ <b>ส่งประกาศล้มเหลว:</b> ${e.message}\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'capture_url':
      apiCounter++;
      await saveDailyData();
      bot.editMessageText(`⏳ <b>[STEALTH CAPTURE]</b>\nกำลังดึงสัญญาณโครงข่ายไร้ร่องรอย... โปรดรอสักครู่`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      monitorSessions.delete(msg.from.id);

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
        
        bot.editMessageText(`🛸 <b>ดึงสื่อสำเร็จ</b>\nส่งตรงไปยังกล่องรับสัญญาณส่วนตัวของคุณเรียบร้อย!\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`❌ <b>เกิดข้อผิดพลาดในการดึงสื่อ:</b> <code>${e.message}</code>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'warn':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ฝ่าฝืนกฎระเบียบกองทัพเอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
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
          setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          await sendSystemLog(`📜 <b>[ AUTO-BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nสาเหตุ: ${reason} (Warn สะสมครบเกณฑ์)\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
          bot.editMessageText(`☢️ <b>รังสีสะสมเต็มขีดจำกัด!</b>\nทำการดีดตัวและสั่งแบนถาวรสำเร็จ\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } else {
          apiCounter += 3;
          await saveDailyData();
          const rem = WARN_LIMIT - currentWarn;
          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีสะสม: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ เหตุผล: <code>${reason}</code>\n🚨 อีก <b>${rem} ครั้ง</b> จะถูกลบตัวตนออกจากโครงข่าย`,
            { parse_mode: 'HTML' }
          );
          setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          await sendSystemLog(`📜 <b>[ WARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ระดับ: ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
          bot.editMessageText(`☢️ <b>ลงทัณฑ์รังสีสำเร็จ [${currentWarn}/${WARN_LIMIT}]</b>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        }
      } catch (e) {
        bot.editMessageText(`⚠️ <b>เกิดข้อผิดพลาดในการสั่ง Warn:</b> <code>${e.message}</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'unwarn':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับอนุญาตล้างพิษจากยานแม่' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
        break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      const oldWarn = getWarnCount(targetGroupId, targetUserId);
      if (oldWarn === 0) {
        bot.editMessageText(`🧬 <b>เป้าหมายไม่มีค่ารังสีตกค้างอยู่แล้ว</b>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
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
        setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        await sendSystemLog(`📜 <b>[ UNWARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ค่าลดลง: ${oldWarn} → ${currentWarn}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        bot.editMessageText(`🧬 <b>บำบัดดีเอ็นเอ Unwarn สำเร็จ!</b>\nระดับพลังงานพิษลดลงเหลือชุดควบคุมปัจจุบัน\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`⚠️ <b>เกิดข้อผิดพลาดในการแก้สถานะ:</b> <code>${e.message}</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'warncheck':
      apiCounter++;
      await saveDailyData();
      targetInput = inputStr.split(' ')[0];
      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
        break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      const checkWarn = getWarnCount(targetGroupId, targetUserId);
      const chkBar = buildWarnBar(checkWarn, WARN_LIMIT);
      const chkText = checkWarn === 0 ? '✅ คลื่นความถี่ปกติ ไม่มีสารพิษ' : checkWarn >= WARN_LIMIT ? '🚨 ระดับสีแดงวิกฤต (อยู่ภายใต้โปรโตคอลแบน)' : `⚠️ มีประวัติสะสมรังสี ควรรักษาความเงียบงัน`;

      bot.editMessageText(`🔬 <b>[ BIO-SCANNER MONITOR REPORT ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>ชื่อชีวภาพ:</b> ${targetName}\n🆔 <b>เลขโครงข่าย:</b> <code>${targetUserId}</code>\n🛰️ <b>เซกเตอร์ยึดครอง:</b> ${groupName}\n☢️ <b>ดัชนีรังสี:</b> [${chkBar}] ${checkWarn}/${WARN_LIMIT}\n📊 <b>สถานะวิเคราะห์:</b> ${chkText}\n━━━━━━━━━━━━━━━━━━━━`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับสู่แผงควบคุมเซกเตอร์', callback_data: `select_group_${groupId}` }]] }
      }).catch(()=>{});
      break;

    case 'replylink':
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
        await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        bot.editMessageText(`📡 <b>ยิงคลื่นสารสัญญาณตอบกลับสำเร็จแล้ว!</b>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`❌ <b>ยิงสัญญาณสารล้มเหลว:</b> <code>${e.message}</code>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'ban':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ตรวจพบพฤติกรรมเป็นภัยต่อกองยานแม่' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
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
        setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        // ย้ายคำสั่งส่ง Log ออกมารองรับอิสระและแนบเวลาประเทศไทยเป๊ะๆ
        await sendSystemLog(`📜 <b>[ EXECUTION BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nผู้สั่งการโจมตี: เจ้าหน้าที่ยานแม่\nข้อหา: ${reason}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        
        bot.editMessageText(`✅ <b>สลายตัวตนเป้าหมายสำเร็จ (Ban)</b>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`⚠️ <b>แบนล้มเหลว (บอทขาดสิทธิ์ผู้ดูแลกลุ่ม?):</b> <code>${e.message}</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'unban':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับการยกเว้นและอภัยโทษจากผู้ควบคุมยาน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
        break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      try {
        apiCounter += 2;
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        
        const m = await bot.sendMessage(targetGroupId, `🟢 <b>[ REANIMATE COMPLETE - UNBAN ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (🆔 <code>${targetUserId}</code>)\n🔓 อนุญาตให้ฟื้นคืนมวลสารกลับเข้าสู่พื้นที่`, { parse_mode: 'HTML' });
        setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        // ย้ายคำสั่งส่ง Log ออกมารองรับอิสระและแนบเวลาประเทศไทยเป๊ะๆ
        await sendSystemLog(`📜 <b>[ UNBAN LOG ]</b>\nเซกเตอร์: ${groupName}\nคืนชีพเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nหมายเหตุ: ${reason}\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`);
        
        bot.editMessageText(`✅ <b>ฟื้นคืนเนื้อเยื่อสำเร็จ (Unban)</b>\n\n<i>🛰️ กำลังคืนค่าหน้าจอหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`⚠️ <b>การปลดแบนขัดข้อง:</b> <code>${e.message}</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;
  }
});

// 🌐 เปิดระบบรับสัญญาณพอร์ตเว็บเซิร์ฟเวอร์หลอกล่อเพื่อป้องกันไม่ให้ Render สั่ง Sleep บอท
http.createServer((req, res) => res.end('ALIEN_STATION_ONLINE')).listen(process.env.PORT || 3000);
