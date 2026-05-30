const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);
const mongoUri = process.env.MONGODB_URI; 

// ตรวจสอบความพร้อมของระบบ
if (!token || !LOG_CHANNEL_ID || !mongoUri) {
  console.error('❌ CRITICAL ERROR: Environment Variables missing!');
  process.exit(1);
}

// 💽 เชื่อมต่อโครงข่ายฐานข้อมูลคลาวด์ถาวร
mongoose.connect(mongoUri)
  .then(() => console.log('💽 Nebula Database: Initializing long-term memory...'))
  .catch(err => {
    console.error('❌ ฐานข้อมูลล้มเหลว:', err.message);
    process.exit(1);
  });

// ==========================================
// 🗄️ การกำหนดโครงสร้างฐานข้อมูล (Schemas)
// ==========================================
const SystemDataSchema = new mongoose.Schema({
  date: String,
  apiCounter: { type: Number, default: 0 },
  warnData: { type: Object, default: {} }
}, { minimize: false }); 
const SystemData = mongoose.model('SystemData', SystemDataSchema);

const PendingPhotoSchema = new mongoose.Schema({
  file_id: String,
  sender_id: String,
  status: { type: String, default: 'pending' }, 
  timestamp: { type: Date, default: Date.now },
  processed_by: String,
  processed_at: Date
});
const PendingPhoto = mongoose.model('PendingPhoto', PendingPhotoSchema);

// [ NEW BETA ] โครงสร้างเก็บกลุ่มเป้าหมายอัตโนมัติ
const SectorSchema = new mongoose.Schema({
  groupId: String,
  name: String,
  addedAt: { type: Date, default: Date.now }
});
const Sector = mongoose.model('Sector', SectorSchema);

// ==========================================
// 🌌 ระบบฐานข้อมูลชั่วคราวและ State
// ==========================================
const usernameCache = {};
const userStates = {}; 
const appSettings = { isAcceptingPhotos: true }; 
let warnData = {};
let apiCounter = 0;
const WARN_LIMIT = 2;
const API_DAILY_MAX = 50000;
const monitorSessions = new Map();

function getTodayDate() { return new Date().toISOString().slice(0, 10); }

async function loadDailyData() {
  try {
    let data = await SystemData.findOne({ date: getTodayDate() });
    if (data) { apiCounter = data.apiCounter || 0; warnData = data.warnData || {}; }
    else { apiCounter = 0; warnData = {}; await saveDailyData(); }
  } catch (e) { console.error('❌ โหลดข้อมูลล้มเหลว:', e.message); }
}

async function saveDailyData() {
  try { await SystemData.findOneAndUpdate({ date: getTodayDate() }, { apiCounter, warnData }, { upsert: true, new: true }); } 
  catch (e) { console.error('❌ บันทึกข้อมูลไม่สำเร็จ:', e.message); }
}
loadDailyData();

function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(async () => {
    apiCounter = 0; warnData = {}; await saveDailyData();
    scheduleMidnightReset();
  }, midnight - now);
}
scheduleMidnightReset();

function startAutoCleanup() {
  setInterval(async () => {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await PendingPhoto.deleteMany({ status: 'pending', timestamp: { $lt: twentyFourHoursAgo } });
      await PendingPhoto.deleteMany({ status: { $in: ['approved', 'rejected'] }, processed_at: { $lt: sevenDaysAgo } });
    } catch (e) { console.error('❌ Auto-Cleanup ขัดข้อง:', e.message); }
  }, 3600000);
}
startAutoCleanup();

// ==========================================
// 👥 การตรวจสอบสิทธิ์กลุ่ม & (Beta) Auto-Sectors
// ==========================================
const WHITELIST_IDS = process.env.WHITELIST_IDS ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) : [];
let ACTIVE_SECTORS = [];

async function loadSectors() {
  ACTIVE_SECTORS = [];
  // โหลดค่าจาก Environment Variables
  if (process.env.TARGET_GROUPS) {
    process.env.TARGET_GROUPS.split(',').forEach(item => {
      const parts = item.split(':');
      if (parts.length >= 2) ACTIVE_SECTORS.push({ id: parts[0].trim(), name: parts.slice(1).join(':').trim() });
    });
  }
  // โหลดค่าจาก MongoDB (ที่ถูกแอดเข้ากลุ่มอัตโนมัติ)
  try {
    const dbSectors = await Sector.find({});
    dbSectors.forEach(sec => {
      if (!ACTIVE_SECTORS.find(s => s.id === sec.groupId)) {
        ACTIVE_SECTORS.push({ id: sec.groupId, name: sec.name });
      }
    });
  } catch (e) { console.error('❌ โหลดข้อมูลเซกเตอร์ล้มเหลว', e.message); }
}

if (WHITELIST_IDS.length === 0) {
  console.error('❌ CRITICAL ERROR: Whitelist ไม่ได้ตั้งค่า!');
  process.exit(1);
}

// ==========================================
// 🚀 เริ่มต้นระบบบอท & แสดงหน้าจอ LOG
// ==========================================
const bot = new TelegramBot(token, { polling: true });
let BOT_ID = null;

bot.getMe().then(async (me) => {
  BOT_ID = me.id;
  await loadSectors(); // โหลดข้อมูลกลุ่มก่อนแสดง Log
  console.log(`
┌────────────────────────────────────────────────────────┐
│   🛸  NEBULA COMMAND CENTER // SYSTEM INITIALIZED      │
│   📡  OPERATIONAL STATUS: ONLINE [SUCCESS]             │
│   🌌  SECTOR MONITORING: ACTIVE & SCANNING...          │
├────────────────────────────────────────────────────────┤
│   [💽 DB STATUS] : Nebula Connected & Loaded           │
│   [👥 OPERATORS] : ${WHITELIST_IDS.length} Administrators Active       │
│   [🛰️ TARGETS]   : ${ACTIVE_SECTORS.length} Sectors Locked & Ready     │
│   [📅 TIME LINK] : ${getTodayDate()} @ ${new Date().toLocaleTimeString()}       │
└────────────────────────────────────────────────────────┘
  `);
});

// ==========================================
// 🔧 ฟังก์ชัน Utilities
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
    return { error: `❌ ไม่พบ ID ของ <code>${trimmed}</code>` };
  }
  const userId = parseInt(trimmed);
  if (isNaN(userId)) return { error: '❌ รูปแบบไม่ถูกต้อง' };
  let name = null;
  for (const key in usernameCache) { if (usernameCache[key].id === userId) { name = usernameCache[key].name; break; } }
  return { userId, name };
}
async function resolveName(userId, groupId) {
  if (usernameCache[`id_${userId}`]) return usernameCache[`id_${userId}`].name;
  for (const key in usernameCache) { if (usernameCache[key].id === userId) return usernameCache[key].name; }
  try {
    apiCounter++; await saveDailyData();
    const member = await bot.getChatMember(groupId, userId);
    const name = `${member.user.first_name || ''} ${member.user.last_name || ''}`.trim() || member.user.username || `ID:${userId}`;
    usernameCache[`id_${userId}`] = { id: userId, name };
    return name;
  } catch (e) { return `ID:${userId}`; }
}

// ==========================================
// 1. เมนูหลัก Command Center
// ==========================================
function sendMainMenu(chatId, messageId = null) {
  apiCounter++; saveDailyData();
  const keyboard = ACTIVE_SECTORS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);
  keyboard.push(
    [{ text: `📊 โควตาพลังงาน API`, callback_data: `view_api_limits` }, { text: `👥 รายชื่อ Whitelist`, callback_data: `view_whitelist` }],
    [{ text: `⚙️ ศูนย์ตั้งค่า & ประกาศปิด/เปิดรับรูป`, callback_data: `admin_settings` }]
  );

  const text = "🛸 <b>แผงควบคุมหลัก: NEBULA COMMAND CENTER</b>\nโปรดเลือกคำสั่ง:";
  const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options }).catch(()=>{});
  else bot.sendMessage(chatId, text, options);
}

function restoreSubmenu(chatId, messageId, groupId) {
  const group = ACTIVE_SECTORS.find(g => g.id == groupId); 
  if (!group) return;
  const submenu = [
    [{ text: '🔴 ล้างบาง (Ban)', callback_data: `opt_ban_${groupId}` }, { text: '🟢 ชุบชีวิต (Unban)', callback_data: `opt_unban_${groupId}` }],
    [{ text: '☢️ ฉีดรังสีเตือน (Warn)', callback_data: `opt_warn_${groupId}` }, { text: '🧬 ล้างพิษ (Unwarn)', callback_data: `opt_unwarn_${groupId}` }],
    [{ text: '🔬 สแกนระดับรังสี (Warn Status)', callback_data: `opt_warncheck_${groupId}` }],
    [{ text: '🧲 ดูดสื่อไร้ร่องรอย (Stealth)', callback_data: `cmd_capture_url_${groupId}` }, { text: '📡 ยิงคลื่นประกาศ', callback_data: `opt_ann_${groupId}` }],
    [{ text: '💬 ตอบกลับด้วยลิงก์ (Reply Link)', callback_data: `opt_replylink_${groupId}` }],
    [{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]
  ];
  bot.editMessageText(`🛰️ <b>พิกัดเซกเตอร์:</b> <code>${group.name}</code>\nโปรดเลือกคำสั่ง:`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  }).catch(()=>{});
}

// ==========================================
// 2. จัดการข้อความ & (Beta) Auto-Register
// ==========================================
bot.on('message', async (msg) => {
  // เก็บแคชข้อมูลผู้ใช้
  if (msg.from) {
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
    usernameCache[`id_${msg.from.id}`] = { id: msg.from.id, name: fullName };
    if (msg.from.username) usernameCache[msg.from.username.toLowerCase()] = { id: msg.from.id, name: fullName };
  }

  // --- [ NEW BETA ] ระบบลงทะเบียนกลุ่มอัตโนมัติ ---
  if (msg.new_chat_members && BOT_ID) {
    const isBotAdded = msg.new_chat_members.some(member => member.id === BOT_ID);
    if (isBotAdded) {
      const adderId = msg.from.id;
      const groupId = msg.chat.id.toString();
      const groupName = msg.chat.title || "Unknown Sector";

      if (WHITELIST_IDS.includes(adderId)) {
        // แอดมินเป็นคนดึงเข้ากลุ่ม -> ลงทะเบียน
        const existing = await Sector.findOne({ groupId });
        if (!existing) {
          await new Sector({ groupId, name: groupName }).save();
          await loadSectors(); // รีเฟรชเมนูแอดมิน
          bot.sendMessage(groupId, `🛸 <b>[ BETA ] AUTO-REGISTER SUCCESS</b>\nเซกเตอร์ <b>${groupName}</b> ถูกเชื่อมต่อเข้าสู่ NEBULA COMMAND CENTER เรียบร้อยแล้ว!`, { parse_mode: 'HTML' });
        }
      } else {
        // คนนอกดึงเข้ากลุ่ม -> กดออกเองเพื่อความปลอดภัย
        bot.sendMessage(groupId, `❌ <b>ACCESS DENIED:</b> ตรวจพบการพยายามเชื่อมต่อจากผู้ที่ไม่มีสิทธิ์ระดับ Operator ระบบจะทำการตัดการเชื่อมต่อ...`, { parse_mode: 'HTML' })
          .then(() => bot.leaveChat(groupId));
      }
      return; 
    }
  }

  if (msg.chat.type !== 'private') return; 

  const numUserId = msg.from.id;
  const userId = numUserId.toString();
  const isAdmin = WHITELIST_IDS.includes(numUserId);

  // --- 2.1 รับภาพ ---
  if (userStates[userId] === 'waiting_for_photo') {
    if (msg.photo) {
      delete userStates[userId];
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const newPhoto = new PendingPhoto({ file_id: fileId, sender_id: userId });
      const savedPhoto = await newPhoto.save();
      const photoDbId = savedPhoto._id.toString();

      await bot.sendMessage(msg.chat.id, "✅ <b>ส่งรูปภาพสำเร็จ 1 รูป</b>\nระบบส่งให้แอดมินพิจารณาแล้วครับ", { parse_mode: 'HTML' });

      for (const adminId of WHITELIST_IDS) {
        try {
          await bot.sendPhoto(adminId, fileId, {
            caption: `🚨 <b>มีรูปใหม่เข้าคิว!</b>\n\n👤 จาก ID: <code>${userId}</code>`, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [ [{ text: "✅ อนุมัติ (ยิงเข้ากลุ่ม)", callback_data: `approve_${photoDbId}` }], [{ text: "❌ ปฏิเสธ (สลายรูปทิ้ง)", callback_data: `reject_${photoDbId}` }] ] }
          });
        } catch (e) {}
      }
      return;
    } else if (msg.text && msg.text.startsWith('/start')) {
      delete userStates[userId];
    } else {
      await bot.sendMessage(msg.chat.id, "❌ กรุณาส่งเป็นไฟล์รูปภาพเท่านั้นครับ");
      return;
    }
  }

  // --- 2.2 จัดการ /start ---
  if (msg.text && msg.text.startsWith('/start')) {
    if (isAdmin) {
      monitorSessions.delete(numUserId);
      sendMainMenu(msg.chat.id);
    } else {
      if (!appSettings.isAcceptingPhotos) return;
      bot.sendMessage(msg.chat.id, "สวัสดีครับ 🎭\nหากคุณต้องการแบ่งปันรูปภาพ สามารถกดปุ่มด้านล่างเพื่อส่งแบบไม่ระบุตัวตนให้แอดมินได้เลยครับ", { reply_markup: { inline_keyboard: [[{ text: "📸 ส่งรูปแบบไม่ระบุตัวตน", callback_data: "send_anonymous" }]] } });
    }
    return;
  }

  if (!isAdmin) return; 

  const session = monitorSessions.get(numUserId);
  if (!session) return;
  if (!msg.text && session.action !== 'ann') return;

  const { chatId, messageId, groupId, action } = session;
  const targetGroupId = groupId; 
  const inputStr = msg.text ? msg.text.trim() : '';

  if (action !== 'ann') bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

  let targetInput = '', reason = '', spaceIdx = -1, resolved, targetUserId, targetName;

  switch (action) {
    case 'capture_url':
      apiCounter++; await saveDailyData();
      bot.editMessageText(`⏳ กำลังเดินเครื่อง...`, { chat_id: chatId, messageId: messageId }).catch(()=>{});
      monitorSessions.delete(numUserId);
      try {
        let tChatId, mId;
        const parts = inputStr.split('/');
        mId = parseInt(parts.pop());
        tChatId = inputStr.includes('/c/') ? "-100" + parts.pop() : "@" + parts.pop();
        apiCounter += 2; await saveDailyData();
        await bot.copyMessage(numUserId, tChatId, mId);
        bot.editMessageText(`🛸 <b>ดึงสื่อสำเร็จ</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) { bot.editMessageText(`❌ <b>ดึงสื่อไม่สำเร็จ:</b> <code>${e.message}</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{}); }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'warn': case 'ban': case 'unban': case 'unwarn': case 'warncheck':
      apiCounter++; await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ละเมิดกฎ' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(numUserId); setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000); break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(numUserId);

      if (action === 'ban') {
        try {
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId); await saveDailyData();
          bot.sendMessage(targetGroupId, `🔴 <b>[ BAN ]</b>\n👤 <b>เป้าหมาย:</b> ${targetName}\n🚨 สาเหตุ: <code>${reason}</code>`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.editMessageText(`✅ <b>สลายร่างเหยื่อสำเร็จ (Ban)</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } catch (e) { bot.editMessageText(`⚠️ <b>แบนไม่สำเร็จ:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      } 
      else if (action === 'unban') {
        try {
          await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
          bot.sendMessage(targetGroupId, `🟢 <b>[ UNBAN ]</b>\n👤 <b>เป้าหมาย:</b> ${targetName}\n🔓 กลับเข้ากลุ่มได้`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.editMessageText(`✅ <b>ชุบชีวิตสำเร็จ (Unban)</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } catch (e) { bot.editMessageText(`⚠️ <b>ปลดแบนไม่สำเร็จ:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      }
      else if (action === 'warn') {
        const currentWarn = addWarn(targetGroupId, targetUserId); await saveDailyData();
        const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);
        if (currentWarn >= WARN_LIMIT) {
          await bot.banChatMember(targetGroupId, targetUserId); clearWarn(targetGroupId, targetUserId); await saveDailyData();
          bot.sendMessage(targetGroupId, `☢️ <b>[ AUTO BAN ]</b>\n👤 ${targetName}\n☢️ รังสี: [${warnBar}]\n💥 สาเหตุ: ${reason}`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.editMessageText(`☢️ <b>Warn ครบ แบนอัตโนมัติสำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } else {
          bot.sendMessage(targetGroupId, `☢️ <b>[ WARN ]</b>\n👤 ${targetName}\n☢️ รังสี: [${warnBar}]\n⚠️ สาเหตุ: ${reason}\n🚨 เหลือโอกาส ${WARN_LIMIT - currentWarn} ครั้ง`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.editMessageText(`☢️ <b>Warn สำเร็จ [${currentWarn}/${WARN_LIMIT}]</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        }
      }
      else if (action === 'unwarn') {
        const newWarn = removeWarn(targetGroupId, targetUserId); await saveDailyData();
        bot.sendMessage(targetGroupId, `🧬 <b>[ UNWARN ]</b>\n👤 ${targetName}\n☢️ รังสีเหลือ: [${newWarn}/${WARN_LIMIT}]`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
        bot.editMessageText(`🧬 <b>ถอนพิษ Unwarn สำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      else if (action === 'warncheck') {
        const currentW = getWarnCount(targetGroupId, targetUserId);
        bot.editMessageText(`🔬 <b>สแกน:</b> ${targetName}\n☢️ <b>รังสี:</b> [${currentW}/${WARN_LIMIT}]`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `select_group_${groupId}` }]] }}).catch(()=>{});
        return; 
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'replylink':
      apiCounter++; await saveDailyData(); monitorSessions.delete(numUserId);
      try {
        spaceIdx = inputStr.indexOf(' ');
        const url = inputStr.substring(0, spaceIdx).trim();
        const replyText = inputStr.substring(spaceIdx).trim();
        const mId = parseInt(url.split('/').pop());
        await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        bot.editMessageText(`📡 <b>ยิงคลื่นตอบกลับสำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) { bot.editMessageText(`❌ <b>ขัดข้อง:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'ann':
      apiCounter += 2; await saveDailyData(); monitorSessions.delete(numUserId);
      try {
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        bot.editMessageText(`📡 <b>ฝังตัวรับส่งสัญญาณสำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) { bot.editMessageText(`❌ <b>ขัดข้อง:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;
  }
});

// ==========================================
// 3. จัดการปุ่มกด (Callback Query)
// ==========================================
bot.on('callback_query', async (query) => {
  const numUserId = query.from.id; const userId = numUserId.toString();
  const isAdmin = WHITELIST_IDS.includes(numUserId);
  const chatId = query.message.chat.id; const messageId = query.message.message_id;
  const data = query.data;

  if (data === 'send_anonymous') {
    if (!appSettings.isAcceptingPhotos) return bot.answerCallbackQuery(query.id, { text: "❌ ขณะนี้ขออนุญาตปิดรับรูปภาพชั่วคราวนะครับ", show_alert: true });
    userStates[userId] = 'waiting_for_photo'; bot.sendMessage(chatId, "📸 <b>ส่งรูปภาพของคุณมาได้เลยครับ!</b>", { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  if (!isAdmin) { apiCounter++; saveDailyData(); return bot.answerCallbackQuery(query.id, { text: '🚨 ปฏิเสธการเข้าถึง!', show_alert: true }); }

  if (data.startsWith('approve_') || data.startsWith('reject_')) {
    const action = data.split('_')[0]; const photoId = data.split('_')[1];
    try {
      const photoRecord = await PendingPhoto.findById(photoId);
      if (!photoRecord || photoRecord.status !== 'pending') {
        bot.answerCallbackQuery(query.id, { text: "⚠️ ไม่พบข้อมูลรูปนี้ หรือถูกจัดการไปแล้ว" });
        return bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      }
      if (action === 'approve') {
        if (ACTIVE_SECTORS.length > 0) {
          await bot.sendPhoto(ACTIVE_SECTORS[0].id, photoRecord.file_id, { caption: "📩 <b>ภาพใหม่ถูกส่งเข้ามา!</b> (ไม่ระบุตัวตน)", parse_mode: 'HTML' });
        }
        photoRecord.status = 'approved';
        await bot.editMessageCaption(`✅ <b>อนุมัติแล้ว:</b> รูปจาก ID <code>${photoRecord.sender_id}</code> ถูกส่งเข้ากลุ่มสำเร็จ`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      } else {
        photoRecord.status = 'rejected';
        await bot.editMessageCaption(`❌ <b>ปฏิเสธแล้ว:</b> รูปถูกทำลายทิ้ง`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      }
      photoRecord.processed_by = userId; photoRecord.processed_at = new Date(); await photoRecord.save();
    } catch (e) { bot.answerCallbackQuery(query.id, { text: "เกิดข้อผิดพลาดฐานข้อมูล" }); }
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'admin_settings' || data === 'toggle_accept_photos') {
    if (data === 'toggle_accept_photos') appSettings.isAcceptingPhotos = !appSettings.isAcceptingPhotos;
    const statusText = appSettings.isAcceptingPhotos ? "✅ <b>เปิด</b>รับภาพนิรนาม" : "❌ <b>ปิด</b>รับภาพนิรนาม";
    const toggleBtn = appSettings.isAcceptingPhotos ? "🔴 ปิดการรับภาพ" : "🟢 เปิดการรับภาพ";
    bot.editMessageText(`⚙️ <b>แผงตั้งค่า: ศูนย์รับภาพ & ระบบแจ้งเตือน</b>\n\nสถานะรับรูปปัจจุบัน: ${statusText}`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [ [{ text: toggleBtn, callback_data: "toggle_accept_photos" }], [ { text: "📢 ประกาศ: 🟢 เปิดรับรูป", callback_data: "warn_open" }, { text: "📢 ประกาศ: 🛑 ปิดรับรูป", callback_data: "warn_close" } ], [{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }] ] }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id, data === 'toggle_accept_photos' ? { text: "บันทึกการตั้งค่าแล้ว!" } : undefined);
  }

  if (data === 'warn_open' || data === 'warn_close') {
    const isOp = data === 'warn_open';
    bot.editMessageText(`⚠️ <b>ยืนยันการประกาศ (${isOp ? 'เปิด' : 'ปิด'}รับรูป)</b>`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [ [{ text: `✅ ยืนยันส่งประกาศ`, callback_data: isOp ? "confirm_open" : "confirm_close" }], [{ text: "❌ ยกเลิก", callback_data: "admin_settings" }] ] }
    }).catch(()=>{}); return bot.answerCallbackQuery(query.id);
  }

  if (data === 'confirm_open' || data === 'confirm_close') {
    const isOp = data === 'confirm_open';
    const msgAnnounce = isOp ? "📢 <b>ประกาศจากระบบ</b> 🟢\n\nเรียน สมาชิกทุกท่าน,\nขณะนี้ระบบ <b>เปิดรับรูปภาพตามปกติแล้ว</b> ครับ 🎉" : "📢 <b>ประกาศจากระบบ</b> 🛑\n\nเรียน สมาชิกทุกท่าน,\nขณะนี้ระบบ <b>ขออนุญาตปิดรับรูปภาพชั่วคราว</b> นะครับ 🙇‍♂️";
    try {
      if (ACTIVE_SECTORS.length > 0) {
        for (const sec of ACTIVE_SECTORS) { await bot.sendMessage(sec.id, msgAnnounce, { parse_mode: 'HTML' }).catch(()=>{}); }
        bot.answerCallbackQuery(query.id, { text: "✅ ส่งประกาศเรียบร้อยแล้ว", show_alert: true });
      } else { bot.answerCallbackQuery(query.id, { text: "❌ ไม่พบกลุ่มเป้าหมาย", show_alert: true }); }
    } catch (e) { bot.answerCallbackQuery(query.id, { text: "❌ ส่งประกาศไม่สำเร็จ", show_alert: true }); }
    appSettings.isAcceptingPhotos = isOp;
    if (ACTIVE_SECTORS.length > 0) restoreSubmenu(chatId, messageId, ACTIVE_SECTORS[0].id); else sendMainMenu(chatId, messageId);
    return;
  }

  if (data.startsWith('cancel_')) {
    const groupId = data.replace('cancel_', ''); monitorSessions.delete(numUserId); bot.answerCallbackQuery(query.id, { text: 'ยกเลิกคำสั่ง กลับสู่เมนู' });
    return restoreSubmenu(chatId, messageId, groupId);
  }
  if (data === 'back_to_main') { sendMainMenu(chatId, messageId); return bot.answerCallbackQuery(query.id); }

  if (data === 'view_api_limits') {
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100)); const bars = Math.round(pct / 10);
    bot.editMessageText(`📊 <b>เครื่องตรวจวัดพลังงานสัญญาณ</b>\nหลอด: [<code>${"🟩".repeat(bars) + "⬜".repeat(10 - bars)}</code>] ${pct}%\nใช้ไป: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code>`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: 'back_to_main' }]] }
    }).catch(()=>{}); return bot.answerCallbackQuery(query.id);
  }

  if (data === 'view_whitelist') {
    let msgList = `👥 <b>รายชื่อโอเปอเรเตอร์ยานแม่</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ร่างอวตารนิรนาม";
      for (const key in usernameCache) if (usernameCache[key].id === id) { name = usernameCache[key].name; break; }
      msgList += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    bot.editMessageText(msgList, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: 'back_to_main' }]] } }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('select_group_')) {
    restoreSubmenu(chatId, messageId, data.replace('select_group_', '')); return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('opt_') || data.startsWith('cmd_capture_url_')) {
    let action, groupId;
    if (data.startsWith('cmd_capture_url_')) { action = 'capture_url'; groupId = data.replace('cmd_capture_url_', ''); } 
    else { const parts = data.split('_'); action = parts[1]; groupId = parts[2]; }
    const prompts = { 'capture_url': '🧲 ป้อนลิงก์เป้าหมาย Telegram:', 'ban': '🔴 ระบุเหยื่อ (@username หรือ ID):', 'unban': '🟢 ระบุเป้าหมายปลดแบน (@username หรือ ID):', 'warn': `☢️ ระบุเป้าหมายฉีดรังสี (ครบ ${WARN_LIMIT} = แบน):`, 'unwarn': '🧬 ระบุเป้าหมายล้างพิษ 1 ครั้ง:', 'warncheck': '🔬 ระบุเป้าหมายสแกนรังสีสะสม:', 'ann': '📡 ส่งไฟล์ภาพ/ข้อความ เพื่อยิงเข้ากลุ่ม:', 'replylink': '💬 ส่งลิงก์ ตามด้วยข้อความตอบกลับ:' };
    monitorSessions.set(numUserId, { chatId, messageId, groupId, action });
    bot.editMessageText(`<b>[ ${action.toUpperCase()} PROTOCOL ]</b>\n${prompts[action]}`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิกคำสั่ง', callback_data: `cancel_${groupId}` }]] } }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }
});

http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
