const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);
const mongoUri = process.env.MONGODB_URI; 

// ตรวจสอบความพร้อมของระบบ
if (!token || !LOG_CHANNEL_ID || !mongoUri) {
  console.error('❌ CRITICAL ERROR: Interstellar Environment Variables missing (Token, Log ID, or MongoDB URI)!');
  process.exit(1);
}

// 💽 เชื่อมต่อโครงข่ายฐานข้อมูลคลาวด์ถาวร
mongoose.connect(mongoUri)
  .then(() => console.log('💽 Nebula Database Connected! ความจำระยะยาวทำงานสมบูรณ์'))
  .catch(err => {
    console.error('❌ ฐานข้อมูลล้มเหลว:', err.message);
    process.exit(1);
  });

// กำหนดโครงสร้างฐานข้อมูล (Schema)
const SystemDataSchema = new mongoose.Schema({
  date: String,
  apiCounter: { type: Number, default: 0 },
  warnData: { type: Object, default: {} }
}, { minimize: false }); 

const SystemData = mongoose.model('SystemData', SystemDataSchema);

// 🌌 ระบบฐานข้อมูลดีเอ็นเอชั่วคราว (เก็บคีย์ Username แปลงเป็น ID และเก็บชื่อเล่น)
const usernameCache = {};

// ☢️ ระบบฐานข้อมูลคำเตือนรังสีพิษในความจำ (Sync กับ Cloud)
let warnData = {};
const WARN_LIMIT = 2;

// 🔋 ระบบตรวจวัดการเรียกใช้งาน API ป้องกันการถูกระงับสัญญาณ
let apiCounter = 0;
const API_DAILY_MAX = 50000;

// 🗂️ Session Storage สำหรับติดตามสถานะการพิมพ์ของ Operator
const monitorSessions = new Map();

function getTodayDate() {
  return new Date().toISOString().slice(0, 10); 
}

// 📂 ฟังก์ชันโหลดและบันทึกข้อมูลถาวรผ่าน MongoDB
async function loadDailyData() {
  try {
    let data = await SystemData.findOne({ date: getTodayDate() });
    if (data) {
      apiCounter = data.apiCounter || 0;
      warnData = data.warnData || {};
      console.log(`📂 โหลดข้อมูลวันนี้ (${getTodayDate()}): API=${apiCounter}, Warns loaded`);
    } else {
      apiCounter = 0;
      warnData = {};
      await saveDailyData();
      console.log(`🔄 รีเซตข้อมูลรายวัน (${getTodayDate()})`);
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
    console.error('❌ บันทึกข้อมูลไม่สำเร็จ:', e.message);
  }
}

loadDailyData();

// ตั้ง Timer รีเซตอัตโนมัติทุกเที่ยงคืน
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - now;
  setTimeout(async () => {
    apiCounter = 0;
    warnData = {};
    await saveDailyData();
    console.log(`🔄 รีเซตรายวันอัตโนมัติ (${getTodayDate()})`);
    scheduleMidnightReset();
  }, msUntilMidnight);
}
scheduleMidnightReset();

// 👥 ระบบ Whitelist
const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

// 🛰️ ระบบ Multi-Group [FIXED BUG: ไม่ใช้ parseInt เพื่อป้องกัน Error จาก Username Group]
const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) {
      const id = parts[0].trim(); // ปล่อยเป็น String เพื่อรองรับทั้ง ID ติดลบและ @username
      const name = parts.slice(1).join(':').trim();
      TARGET_GROUPS.push({ id: id, name: name });
    }
  });
}

if (WHITELIST_IDS.length === 0 || TARGET_GROUPS.length === 0) {
  console.error('❌ CRITICAL ERROR: Whitelist หรือ Target Groups ไม่ได้ตั้งค่า!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🛸 UFO Alien Invasion Engine Active! Overlords: ${WHITELIST_IDS.length} | Target Sectors: ${TARGET_GROUPS.length}`);

// ==========================================
// 🔧 ฟังก์ชันช่วยระบบ Warn & Utilities
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
    return { error: `❌ ไม่พบ ID ของ <code>${trimmed}</code> ในระบบ\n💡 ให้เป้าหมายส่งข้อความในกลุ่มก่อน หรือใส่ตัวเลข ID แทน` };
  }
  const userId = parseInt(trimmed);
  if (isNaN(userId)) {
    return { error: '❌ รูปแบบไม่ถูกต้อง ใช้ <code>@username</code> หรือ <code>ตัวเลข ID</code>' };
  }
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
// 1. เมนูหลัก Command Center (ระบบจอทีวี)
// ==========================================
function sendMainMenu(chatId, messageId = null) {
  apiCounter++;
  saveDailyData();
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);

  keyboard.push([
    { text: `📊 โควตาพลังงาน API`, callback_data: `view_api_limits` },
    { text: `👥 รายชื่อ Whitelist`, callback_data: `view_whitelist` }
  ]);

  const text = "🛸 <b>แผงควบคุมหลัก: กองทัพเอเลี่ยนต่างดาว (Alien Attack Machine)</b>\nยินดีต้อนรับท่านผู้บัญชาการ โปรดเลือกเซกเตอร์ดาวเทียมที่ต้องการเข้าควบคุม:";
  const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options }).catch(()=>{});
  } else {
    bot.sendMessage(chatId, text, options);
  }
}

function restoreSubmenu(chatId, messageId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId); // ใช้ == เทียบ String/Number
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
      { text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }
    ]
  ];

  bot.editMessageText(`🛰️ <b>พิกัดเซกเตอร์ที่ล็อกไว้:</b> <code>${group.name}</code>\nโปรดเลือกคำสั่งโปรโตคอลการโจมตีหรือดูดกลืนข้อมูล:`, {
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
// 2. จัดการปุ่มกด (Inline Keyboard)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    apiCounter++;
    saveDailyData();
    return bot.answerCallbackQuery(query.id, { text: 'ปฏิเสธการเข้าถึง! โครงข่ายไม่รู้จักรหัสสัญญาณของคุณ', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (data.startsWith('cancel_')) {
    const groupId = data.replace('cancel_', '');
    monitorSessions.delete(query.from.id);
    bot.answerCallbackQuery(query.id, { text: 'ยกเลิกคำสั่ง กลับสู่เมนู' });
    return restoreSubmenu(chatId, messageId, groupId);
  }

  if (data === 'back_to_main') {
    apiCounter += 2;
    saveDailyData();
    sendMainMenu(chatId, messageId);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'view_api_limits') {
    apiCounter += 2;
    saveDailyData();
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
    const bars = Math.round(pct / 10);
    const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
    
    bot.editMessageText(`📊 <b>เครื่องตรวจวัดพลังงานสัญญาณขีดจำกัด API</b>\n\nหลอดพลังงาน: [<code>${barStr}</code>] ${pct}%\nดึงสัญญาณไปแล้ว: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง\n\n⚠️ <i>คำเตือน: โปรดควบคุมการยิงสัญญานไม่ให้ทะลุ 100% เพื่อป้องกันระบบป้องกันของ Telegram ตรวจจับ</i>`, {
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
    let whitelistMessage = `👥 <b>รายชื่อโอเปอเรเตอร์ผู้ควบคุมยานแม่ (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ร่างอวตารนิรนาม (ยังไม่พบประวัติพิมพ์ข้อความ)";
      for (const key in usernameCache) {
        if (usernameCache[key].id === id) { name = usernameCache[key].name; break; }
      }
      whitelistMessage += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    whitelistMessage += `━━━━━━━━━━━━━━━━━━━━\n🛸 <i>สิทธิ์ในการสั่งการและแก้ไขชั้นบรรยากาศสูงสุด</i>`;
    
    bot.editMessageText(whitelistMessage, {
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
    if (action === 'capture_url') promptMsg = `🧲 <b>[QUANTUM TRACTOR BEAM] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nป้อนลิงก์เป้าหมาย Telegram ลงในเครื่องสแกนชีวภาพ (เช่น https://t.me/c/xxxx/xxxx):`;
    else if (action === 'ban') promptMsg = `🔴 <b>[VAPORIZE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุเหยื่อที่จะล้างบาง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`;
    else if (action === 'unban') promptMsg = `🟢 <b>[REANIMATE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุดีเอ็นเอที่จะชุบชีวิตกลับมา:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`;
    else if (action === 'warn') promptMsg = `☢️ <b>[RADIATION INJECTION PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่จะฉีดรังสีพิษ (ครบ ${WARN_LIMIT} ครั้ง = แบนอัตโนมัติ):\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`;
    else if (action === 'unwarn') promptMsg = `🧬 <b>[DNA DETOX PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่จะถอนรังสีพิษออก 1 ครั้ง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสตัวเลข ID เหตุผล</code>`;
    else if (action === 'warncheck') promptMsg = `🔬 <b>[RADIATION SCANNER] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nระบุเป้าหมายที่ต้องการสแกนระดับรังสีสะสม:\nรูปแบบ: <code>@username</code> หรือ <code>รหัสตัวเลข ID</code>`;
    else if (action === 'ann') promptMsg = `📡 <b>[BEAM TRANSMISSION] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งไฟล์ภาพ วิดีโอ หรือข้อความ เพื่อฝังตัวเข้าโครงข่ายประสาทของเซกเตอร์แบบเนทีฟ:`;
    else if (action === 'replylink') promptMsg = `💬 <b>[REPLY LINK PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์พิกัดข้อความ ตามด้วยข้อความที่จะตอบกลับแบบเนทีฟ\nรูปแบบ: <code>[ลิงก์ข้อความ] [เว้นวรรค] [ข้อความตอบกลับ]</code>\nตัวอย่าง: <code>https://t.me/c/123/456 เปิดระบบสแกนแล้วมนุษย์โลก</code>`;

    monitorSessions.set(query.from.id, { chatId, messageId, groupId, action });

    bot.editMessageText(promptMsg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิกคำสั่ง (Cancel)', callback_data: `cancel_${groupId}` }]] }
    });
    return bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 3. ระบบประมวลผลข้อความผ่านเซสชัน
// ==========================================
bot.on('message', async (msg) => {
  // บันทึกโปรไฟล์ลง Cache เสมอ เพื่อให้ค้นหาชื่อเป้าหมายได้
  if (msg.from) {
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
    const idKey = `id_${msg.from.id}`;
    usernameCache[idKey] = { id: msg.from.id, name: fullName };
    if (msg.from.username) {
      const usernameKey = msg.from.username.toLowerCase().replace('@', '');
      usernameCache[usernameKey] = { id: msg.from.id, name: fullName };
    }
  }

  // อนุญาตเฉพาะคนใน Whitelist
  if (!WHITELIST_IDS.includes(msg.from.id)) return;

  // 🛡️ [FIXED BUG]: บล็อกการอ่านข้อความจาก "ในกลุ่ม" ป้องกันบอทดึงผิดแชทเวลา Operator พิมพ์ในกลุ่ม
  if (msg.chat.type !== 'private') return; 

  if (msg.text && msg.text.startsWith('/start')) return;

  const session = monitorSessions.get(msg.from.id);
  if (!session) return;
  
  if (!msg.text && session.action !== 'ann') return;

  const { chatId, messageId, groupId, action } = session;
  const targetGroupId = groupId; // 🛡️ [FIXED BUG]: ลบ parseInt ออก เพื่อรักษาโครงสร้าง @username
  const groupObj = TARGET_GROUPS.find(g => g.id == targetGroupId);
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
    case 'capture_url':
      apiCounter++;
      await saveDailyData();
      bot.editMessageText(`⏳ <b>[QUANTUM TRACTOR BEAM]</b>\nกำลังเดินเครื่องดูดกลืนข้อมูลสัญญาณ... โปรดรอสักครู่`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      monitorSessions.delete(msg.from.id);

      try {
        let tChatId, mId;
        if (inputStr.includes('/c/')) {
          const parts = inputStr.split('/');
          mId = parseInt(parts.pop());
          tChatId = "-100" + parts.pop(); // เปลี่ยนเป็น String รักษาความแม่นยำ
        } else {
          const parts = inputStr.split('/');
          mId = parseInt(parts.pop());
          tChatId = "@" + parts.pop();
        }
        if (!tChatId || isNaN(mId)) throw new Error("พิกัดคลื่นพอร์ตดวงดาวไม่ถูกต้อง");
        
        apiCounter += 2;
        await saveDailyData();
        await bot.copyMessage(msg.from.id, tChatId, mId);
        
        bot.editMessageText(`🛸 <b>ดึงสื่อสำเร็จ</b>\nระบบส่งเข้าห้องข้อความส่วนตัวของท่านเรียบร้อยแล้ว\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        apiCounter++;
        await saveDailyData();
        bot.editMessageText(`❌ <b>ดึงสื่อไม่สำเร็จ:</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'warn':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ตรวจพบพฤติกรรมเบี่ยงเบนจากโปรโตคอลกองทัพเอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim() || 'ตรวจพบพฤติกรรมเบี่ยงเบนจากโปรโตคอลกองทัพเอเลี่ยน';

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
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
            `☢️ <b>[ RADIATION OVERLOAD - AUTO BAN ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a> (<code>${targetUserId}</code>)\n☢️ รังสี: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n💥 สาเหตุ: <code>${reason}</code>\n☠️ ถูกขับออกนอกชั้นบรรยากาศ (AUTO-BAN)\n⏰ <i>ระเหยใน 60 วิ...</i>`,
            { parse_mode: 'HTML' }
          );
          setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          await bot.sendMessage(LOG_CHANNEL_ID,
            `📜 <b>[ AUTO-BAN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>)\nสาเหตุ: ${reason} | Warn ครบ ${WARN_LIMIT}`,
            { parse_mode: 'HTML' }
          );
          bot.editMessageText(`☢️ <b>Warn ครบ ${WARN_LIMIT}/${WARN_LIMIT}</b>\nระบบทำการระเบิดแบนเป้าหมายอัตโนมัติสำเร็จ!\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } else {
          apiCounter += 3;
          await saveDailyData();
          const remaining = WARN_LIMIT - currentWarn;
          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a> (<code>${targetUserId}</code>)\n☢️ รังสี: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ สาเหตุ: <code>${reason}</code>\n🚨 อีก <b>${remaining} ครั้ง</b> จะถูกแบนอัตโนมัติ\n⏰ <i>ระเหยใน 60 วิ...</i>`,
            { parse_mode: 'HTML' }
          );
          setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

          await bot.sendMessage(LOG_CHANNEL_ID,
            `📜 <b>[ WARN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>) | ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}`,
            { parse_mode: 'HTML' }
          );
          bot.editMessageText(`☢️ <b>Warn สำเร็จ [${currentWarn}/${WARN_LIMIT}]</b>\nเป้าหมายเหลือโอกาสอีก ${remaining} ครั้ง\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        }
      } catch (e) {
        bot.editMessageText(`⚠️ <b>ระบบ Warn ขัดข้อง:</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'unwarn':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับการล้างพิษจากศูนย์ควบคุมยานแม่' : inputStr.substring(spaceIdx + 1).trim() || 'ได้รับการล้างพิษจากศูนย์ควบคุมยานแม่';

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
        break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      const prevWarn = getWarnCount(targetGroupId, targetUserId);
      if (prevWarn === 0) { 
        bot.editMessageText(`🧬 <b>เป้าหมายไม่มีค่ารังสีพิษ (Warn) สะสมอยู่แล้ว</b>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
        break; 
      }

      const newWarn = removeWarn(targetGroupId, targetUserId);
      await saveDailyData();
      const wBar = buildWarnBar(newWarn, WARN_LIMIT);

      try {
        apiCounter += 3;
        await saveDailyData();
        const m = await bot.sendMessage(targetGroupId,
          `🧬 <b>[ DNA DETOX COMPLETE ]</b>\n👤 <b>เป้าหมาย:</b> <a href="tg://user?id=${targetUserId}">${targetName}</a> (<code>${targetUserId}</code>)\n☢️ รังสีหลังล้าง: [${wBar}] ${newWarn}/${WARN_LIMIT}\n💉 หมายเหตุ: <code>${reason}</code>\n⏰ <i>ระเหยใน 60 วิ...</i>`,
          { parse_mode: 'HTML' }
        );
        setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        await bot.sendMessage(LOG_CHANNEL_ID,
          `📜 <b>[ UNWARN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>) | ${prevWarn} → ${newWarn}\nหมายเหตุ: ${reason}`,
          { parse_mode: 'HTML' }
        );
        bot.editMessageText(`🧬 <b>ถอนพิษ Unwarn สำเร็จ!</b>\nระดับรังสีเป้าหมายลดลงเหลือ [${newWarn}/${WARN_LIMIT}]\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`⚠️ <b>Unwarn ขัดข้อง:</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'warncheck':
      apiCounter++;
      await saveDailyData();
      targetInput = inputStr.split(' ')[0];
      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(msg.from.id);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
        break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(msg.from.id);

      const currentW = getWarnCount(targetGroupId, targetUserId);
      const cBar = buildWarnBar(currentW, WARN_LIMIT);
      const statusText = currentW === 0 ? '✅ ไม่พบรังสีสะสม' : currentW >= WARN_LIMIT ? '🚨 ระดับวิกฤต! อยู่ในขั้นถูกแบน' : `⚠️ มีรังสีสะสม — อีก ${WARN_LIMIT - currentW} ครั้งจะถูกแบน`;

      bot.editMessageText(`🔬 <b>[ RADIATION SCANNER REPORT ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>เป้าหมาย:</b> ${targetName} (<code>${targetUserId}</code>)\n🛰️ <b>เซกเตอร์:</b> ${groupName}\n☢️ <b>ระดับรังสี:</b> [${cBar}] ${currentW}/${WARN_LIMIT}\n📡 <b>สถานะคลื่น:</b> ${statusText}\n━━━━━━━━━━━━━━━━━━━━`, {
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
        if (spaceIdx === -1) throw new Error("โปรดเคาะเว้นวรรคหลังลิงก์แล้วตามด้วยข้อความที่จะใช้ตอบกลับ");

        const url = inputStr.substring(0, spaceIdx).trim();
        const replyText = inputStr.substring(spaceIdx).trim();
        let mId;

        if (url.includes('/c/')) {
          const parts = url.split('/');
          mId = parseInt(parts.pop());
        } else {
          const parts = url.split('/');
          mId = parseInt(parts.pop());
        }

        if (isNaN(mId)) throw new Error("รูปแบบพิกัดข้อความไม่สมบูรณ์");

        apiCounter += 2;
        await saveDailyData();
        await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        bot.editMessageText(`📡 <b>ยิงคลื่นสัญญาณประสาทตอบกลับสำเร็จ!</b>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`❌ <b>ตอบกลับไม่สำเร็จ:</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'ban':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ตรวจพบการขัดขวางและต่อต้านกองทัพเอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim() || 'ตรวจพบการขัดขวางและต่อต้านกองทัพเอเลี่ยน';

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
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
        
        const m = await bot.sendMessage(targetGroupId, `🔴 <b>[ BAN VAPORIZED ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (<code>${targetUserId}</code>)\n🚨 สาเหตุ: <code>${reason}</code>\n🛸 ถูกขับออกนอกชั้นบรรยากาศ (Vaporized)\n⏰ <i>ระเหยใน 60 วิ...</i>`, { parse_mode: 'HTML' });
        setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ BAN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>)\nสาเหตุ: ${reason}`, { parse_mode: 'HTML' });
        bot.editMessageText(`✅ <b>สลายร่างเหยื่อสำเร็จ (Ban)</b>\nบันทึกประวัติลง Log เรียบร้อยแล้ว\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`⚠️ <b>แบนไม่สำเร็จ (บอทขาดสิทธิ์แอดมิน?):</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'unban':
      apiCounter++;
      await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับการอภัยโทษสูงสุดจากยานแม่เอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim() || 'ได้รับการอภัยโทษสูงสุดจากยานแม่เอเลี่ยน';

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
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
        
        const m = await bot.sendMessage(targetGroupId, `🟢 <b>[ UNBAN REANIMATED ]</b>\n👤 <b>เป้าหมาย:</b> <b>${targetName}</b> (<code>${targetUserId}</code>)\n🔓 ได้รับอนุญาตให้กลับเข้ากลุ่มได้อีกครั้ง\n⏰ <i>ระเหยใน 60 วิ...</i>`, { parse_mode: 'HTML' });
        setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ UNBAN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้าหมาย: ${targetName} (<code>${targetUserId}</code>)\nสาเหตุ: ${reason}`, { parse_mode: 'HTML' });
        bot.editMessageText(`✅ <b>ชุบชีวิตเนื้อเยื่อสำเร็จ (Unban)</b>\nเป้าหมายสามารถกลับเข้ากลุ่มได้แล้ว\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`⚠️ <b>ปลดแบนไม่สำเร็จ:</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    // ==========================================
    // 📡 โหมดประกาศคลื่นประสาท (FIXED TRANSMIT)
    // ==========================================
    case 'ann':
      apiCounter += 2;
      await saveDailyData();
      monitorSessions.delete(msg.from.id);
      try {
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        
        // ลบข้อความอินพุตเมื่อส่งสำเร็จ
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        
        bot.editMessageText(`📡 <b>ฝังตัวรับส่งสัญญาณเข้ากลุ่มสำเร็จ!</b>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        // หากส่งไม่สำเร็จ บอทจะแจ้งสาเหตุที่หน้าจอเพื่อให้แก้ไขได้ถูกจุด
        bot.editMessageText(`❌ <b>ส่งไม่สำเร็จ:</b> <code>${e.message}</code>\n\n🛰️ <i>กำลังกลับสู่หน้าควบคุมหลัก...</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;
  }
});

http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
