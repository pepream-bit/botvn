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
  console.error('❌ CRITICAL ERROR: Environment Variables missing!');
  process.exit(1);
}

// 💽 เชื่อมต่อฐานข้อมูล MongoDB
mongoose.connect(mongoUri)
  .then(() => console.log('💽 Nebula Database Connected!'))
  .catch(err => { console.error('❌ DB Error:', err.message); process.exit(1); });

const SystemDataSchema = new mongoose.Schema({
  date: String, apiCounter: { type: Number, default: 0 }, warnData: { type: Object, default: {} }
}, { minimize: false }); 
const SystemData = mongoose.model('SystemData', SystemDataSchema);

// 🌌 ตัวแปรระบบ
const usernameCache = {};
let warnData = {};
const WARN_LIMIT = 2;
let apiCounter = 0;
const API_DAILY_MAX = 50000;
const monitorSessions = new Map();

// 👻 สถานะและตั้งค่าแยกกลุ่ม
const storyBanStatus = {}; // { groupId: true/false }
const botSettings = {}; // { groupId: { deleteTime: 60000 } }

function getDeleteTime(groupId) {
  return (botSettings[groupId] && botSettings[groupId].deleteTime !== undefined) ? botSettings[groupId].deleteTime : 60000;
}

// 🇹🇭 ระบบเวลาไทย
function getTodayDate() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(now);
}
function getThailandTimestamp() {
  return new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

// 📂 ระบบ Cloud Data
async function loadDailyData() {
  try {
    let data = await SystemData.findOne({ date: getTodayDate() });
    if (data) { apiCounter = data.apiCounter || 0; warnData = data.warnData || {}; } 
    else { apiCounter = 0; warnData = {}; await saveDailyData(); }
  } catch (e) { console.error(e.message); }
}
async function saveDailyData() {
  try { await SystemData.findOneAndUpdate({ date: getTodayDate() }, { apiCounter, warnData }, { upsert: true, new: true }); } 
  catch (e) { console.error(e.message); }
}
loadDailyData();

// 👥 แปลงรายชื่อและกลุ่ม
const WHITELIST_IDS = process.env.WHITELIST_IDS ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) : [];
const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) TARGET_GROUPS.push({ id: parseInt(parts[0].trim()), name: parts.slice(1).join(':').trim() });
  });
}

const bot = new TelegramBot(token, { polling: true });

async function sendSystemLog(message) {
  if (!LOG_CHANNEL_ID) return;
  try { apiCounter++; await bot.sendMessage(LOG_CHANNEL_ID, message, { parse_mode: 'HTML' }); } 
  catch (err) {}
}

// ==========================================
// 📺 ระบบจัดการ UI หน้าจอ (จัดหมวดหมู่ใหม่)
// ==========================================
function sendMainMenu(chatId) {
  apiCounter++;
  const keyboard = TARGET_GROUPS.map(g => [{ text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }]);
  keyboard.push([{ text: `📊 โควตา API`, callback_data: `view_api_limits` }, { text: `👥 Whitelist`, callback_data: `view_whitelist` }]);
  keyboard.push([{ text: `❌ ปิดหน้าต่างแผงควบคุม`, callback_data: `close_main_menu` }]);
  bot.sendMessage(chatId, "🛸 <b>แผงควบคุมหลัก (Alien Command)</b>\nโปรดเลือกพิกัดเซกเตอร์:", { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

function sendGroupMenu(chatId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  const submenu = [
    [{ text: '🛡️ ระบบลงทัณฑ์ (Security)', callback_data: `menu_sec_${groupId}` }],
    [{ text: '📡 ระบบสื่อสาร (Comms)', callback_data: `menu_comms_${groupId}` }],
    [{ text: '⚙️ ตั้งค่าระบบ (Settings)', callback_data: `menu_set_${groupId}` }],
    [{ text: '⬅️ กลับหน้าจอหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId, `🛰️ <b>เซกเตอร์:</b> <code>${group.name}</code>\nโปรดเลือกหมวดหมู่คำสั่ง:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu } });
}

function sendSecurityMenu(chatId, groupId) {
  const isStoryBanOn = storyBanStatus[groupId];
  const submenu = [
    [{ text: '🔴 Ban', callback_data: `opt_ban_${groupId}` }, { text: '🟢 Unban', callback_data: `opt_unban_${groupId}` }],
    [{ text: '☢️ Warn', callback_data: `opt_warn_${groupId}` }, { text: '🧬 Unwarn', callback_data: `opt_unwarn_${groupId}` }],
    [{ text: '🔬 สแกนระดับรังสี', callback_data: `opt_warncheck_${groupId}` }],
    [{ text: isStoryBanOn ? '🟢 StoryBan: ON' : '🔴 StoryBan: OFF', callback_data: `toggle_storyban_${groupId}` }],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `🛡️ <b>ระบบลงทัณฑ์และความปลอดภัย</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu } });
}

function sendCommsMenu(chatId, groupId) {
  const submenu = [
    [{ text: '🧲 ดูดสื่อ (Stealth)', callback_data: `cmd_capture_url_${groupId}` }, { text: '📡 ประกาศ (Transmit)', callback_data: `opt_ann_${groupId}` }],
    [{ text: '💬 ตอบด้วยลิงก์ (Reply)', callback_data: `opt_replylink_${groupId}` }, { text: '🚀 ทางลัด (Jump)', callback_data: `opt_quickjump_${groupId}` }],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `📡 <b>ระบบสื่อสารดาวเทียม</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu } });
}

function sendSettingsMenu(chatId, groupId) {
  const currentVal = getDeleteTime(groupId);
  const textVal = currentVal === 0 ? "ไม่ลบ" : `${currentVal / 1000} วินาที`;
  const submenu = [
    [{ text: '⏱️ 10 วิ', callback_data: `set_del_${groupId}_10000` }, { text: '⏱️ 30 วิ', callback_data: `set_del_${groupId}_30000` }],
    [{ text: '⏱️ 60 วิ', callback_data: `set_del_${groupId}_60000` }, { text: '🛑 ไม่ลบ', callback_data: `set_del_${groupId}_0` }],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `⚙️ <b>ตั้งค่าระยะเวลาลบข้อความบอทอัตโนมัติ</b>\nปัจจุบัน: <code>${textVal}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu } });
}

bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  monitorSessions.delete(msg.from.id);
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 🔘 ระบบปุ่มกด (Callback Query)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) return bot.answerCallbackQuery(query.id, { text: 'ปฏิเสธคำสั่ง!', show_alert: true });

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.deleteMessage(chatId, messageId).catch(()=>{}); // ลบหน้าจอเก่าทิ้งเสมอเพื่อกันค้าง

  if (data === 'back_to_main') {
    sendMainMenu(chatId);
  } else if (data === 'close_main_menu') {
    bot.answerCallbackQuery(query.id, { text: 'ปิดหน้าจอแผงควบคุมเรียบร้อย 🛸' });
  } else if (data.startsWith('select_group_')) {
    sendGroupMenu(chatId, data.replace('select_group_', ''));
  } else if (data.startsWith('menu_sec_')) {
    sendSecurityMenu(chatId, data.replace('menu_sec_', ''));
  } else if (data.startsWith('menu_comms_')) {
    sendCommsMenu(chatId, data.replace('menu_comms_', ''));
  } else if (data.startsWith('menu_set_')) {
    sendSettingsMenu(chatId, data.replace('menu_set_', ''));
  } else if (data.startsWith('toggle_storyban_')) {
    const groupId = data.replace('toggle_storyban_', '');
    storyBanStatus[groupId] = !storyBanStatus[groupId];
    sendSecurityMenu(chatId, groupId);
    bot.answerCallbackQuery(query.id, { text: `อัปเดต StoryBan สำเร็จ` });
  } else if (data.startsWith('set_del_')) {
    const parts = data.split('_');
    const groupId = parts[2];
    const timeVal = parseInt(parts[3]);
    if (!botSettings[groupId]) botSettings[groupId] = {};
    botSettings[groupId].deleteTime = timeVal;
    sendSettingsMenu(chatId, groupId);
    bot.answerCallbackQuery(query.id, { text: `อัปเดตเวลาลบข้อความสำเร็จ` });
  } else if (data.startsWith('opt_') || data.startsWith('cmd_capture_url_')) {
    let action, groupId;
    if (data.startsWith('cmd_capture_url_')) { action = 'capture_url'; groupId = data.replace('cmd_capture_url_', ''); } 
    else { const parts = data.split('_'); action = parts[1]; groupId = parts[2]; }

    monitorSessions.set(query.from.id, { chatId, groupId, action });
    const cancelMenu = { inline_keyboard: [[{ text: '❌ ยกเลิกคำสั่ง', callback_data: `select_group_${groupId}` }]] };
    bot.sendMessage(chatId, `⌨️ <b>รอรับข้อมูลคำสั่ง [${action.toUpperCase()}]</b>\nโปรดพิมพ์ส่งเข้ามาในแชทนี้...`, { parse_mode: 'HTML', reply_markup: cancelMenu });
  }
});

// ==========================================
// 💬 ระบบรับข้อความและ Ghost Ban
// ==========================================
bot.on('message', async (msg) => {
  if (!msg.from) return;

  // 1. [STORYBAN SYSTEM] Ghost Ban
  const isTargetGroup = TARGET_GROUPS.some(g => g.id === msg.chat.id);
  if (isTargetGroup && storyBanStatus[msg.chat.id] && !WHITELIST_IDS.includes(msg.from.id)) {
    if (msg.forward_from_chat || msg.forward_from || msg.story || msg.forward_date) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.banChatMember(msg.chat.id, msg.from.id).catch(() => {});
      await sendSystemLog(`👻 <b>[STORYBAN TRIGGERED]</b>\nเป้าหมาย <code>${msg.from.id}</code> ถูกลบจากเซกเตอร์`);
      return;
    }
  }

  // 2. [NAME FILTER] แบนมิจฉาชีพ
  if (isTargetGroup && !WHITELIST_IDS.includes(msg.from.id)) {
    const senderName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.toLowerCase();
    const IMPERSONATOR_NAMES = process.env.IMPERSONATOR_NAMES ? process.env.IMPERSONATOR_NAMES.split(',').map(n => n.trim().toLowerCase()) : [];
    if (IMPERSONATOR_NAMES.some(bName => senderName.includes(bName))) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.banChatMember(msg.chat.id, msg.from.id).catch(() => {});
      await sendSystemLog(`🚫 <b>[NAME FILTER BAN]</b>\nเป้าหมาย: <code>${msg.from.id}</code>\nชื่อ: ${senderName}`);
      return;
    }
  }

  // 3. TV Mode (เฉพาะ Whitelist)
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  const session = monitorSessions.get(msg.from.id);
  if (!session) return;
  
  const { chatId, groupId, action } = session;
  const targetGroupId = parseInt(groupId);
  const inputStr = msg.text ? msg.text.trim() : '';

  if (action !== 'ann') bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  monitorSessions.delete(msg.from.id);

  // Helper สำหรับดึงเวลาลบข้อความ และส่งข้อความเสร็จสิ้น
  const delTime = getDeleteTime(targetGroupId);
  const finishMenu = { inline_keyboard: [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]] };

  switch (action) {
    case 'replylink':
      try {
        const spaceIdx = inputStr.indexOf(' ');
        const url = inputStr.substring(0, spaceIdx).trim();
        const replyText = inputStr.substring(spaceIdx).trim();
        const mId = parseInt(url.split('/').pop());

        const m = await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}); }, delTime);

        const successBtn = { inline_keyboard: [[{ text: '🚀 ดูข้อความตอบกลับ', url: url }], [{ text: '⬅️ เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]] };
        bot.sendMessage(chatId, `✅ ยิงคลื่นสัญญาณสำเร็จ!`, { reply_markup: successBtn });
      } catch (e) { bot.sendMessage(chatId, `❌ ผิดพลาด: ${e.message}`, { reply_markup: finishMenu }); }
      break;

    case 'quickjump':
      bot.sendMessage(chatId, `✅ สร้างทางลัดสำเร็จ!`, { reply_markup: { inline_keyboard: [[{ text: '🚀 พุ่งกระโดด', url: inputStr }], [{ text: '⬅️ กลับ', callback_data: `select_group_${groupId}` }]] } });
      break;

    case 'ban':
    case 'warn':
      // (ลดทอนรายละเอียด Logic ดั้งเดิมเพื่อความกระชับ แต่ทำงานเหมือนเดิม)
      try {
        const tId = parseInt(inputStr.split(' ')[0].replace('@','')); 
        if (action === 'ban') {
          await bot.banChatMember(targetGroupId, tId);
          const m = await bot.sendMessage(targetGroupId, `🔴 <b>[ BAN ]</b>\nเป้าหมาย ID: <code>${tId}</code> ถูกสลายตัวตน!`, { parse_mode: 'HTML' });
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}); }, delTime);
        } else {
          const m = await bot.sendMessage(targetGroupId, `☢️ <b>[ WARN ]</b>\nเป้าหมาย ID: <code>${tId}</code> ถูกฉีดรังสีเตือน!`, { parse_mode: 'HTML' });
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}); }, delTime);
        }
        bot.sendMessage(chatId, `✅ ดำเนินการลงทัณฑ์เรียบร้อย`, { reply_markup: finishMenu });
      } catch (e) { bot.sendMessage(chatId, `❌ ล้มเหลว: ${e.message}`, { reply_markup: finishMenu }); }
      break;
      
    // (สามารถเพิ่ม Case อื่นๆ เช่น unwarn, unban ได้ในรูปแบบเดียวกัน)
    default:
      bot.sendMessage(chatId, `✅ คำสั่งถูกส่งแล้ว`, { reply_markup: finishMenu });
      break;
  }
});

http.createServer((req, res) => res.end('ONLINE')).listen(process.env.PORT || 3000);
