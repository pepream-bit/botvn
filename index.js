const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);
const mongoUri = process.env.MONGODB_URI; 

// ตรวจสอบความพร้อมของระบบ
if (!token || !LOG_CHANNEL_ID || !mongoUri) {
  console.error('❌ CRITICAL ERROR: Interstellar Environment Variables missing!');
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

// 📂 [เพิ่มใหม่] โครงสร้างฐานข้อมูลสำหรับเก็บรูปภาพรออนุมัติ
const PendingPhotoSchema = new mongoose.Schema({
  file_id: String,
  sender_id: String,
  status: { type: String, default: 'pending' }, // pending, approved, rejected
  timestamp: { type: Date, default: Date.now },
  processed_by: String,
  processed_at: Date
});
const PendingPhoto = mongoose.model('PendingPhoto', PendingPhotoSchema);

// 🌌 ระบบฐานข้อมูลชั่วคราวและ State
const usernameCache = {};
const userStates = {}; // ติดตามว่าใครกำลังส่งรูป
const appSettings = { isAcceptingPhotos: true }; // เปิด-ปิด รับรูปจาก Member

// ☢️ ระบบคำเตือนรังสี & โควตา API
let warnData = {};
const WARN_LIMIT = 2;
let apiCounter = 0;
const API_DAILY_MAX = 50000;

// 🗂️ Session Storage สำหรับติดตามสถานะของ Operator
const monitorSessions = new Map();

function getTodayDate() {
  return new Date().toISOString().slice(0, 10); 
}

// 📂 ฟังก์ชันโหลดและบันทึกข้อมูลถาวร
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
  setTimeout(async () => {
    apiCounter = 0;
    warnData = {};
    await saveDailyData();
    console.log(`🔄 รีเซตรายวันอัตโนมัติ (${getTodayDate()})`);
    scheduleMidnightReset();
  }, midnight - now);
}
scheduleMidnightReset();

// 👥 ระบบ Whitelist และ Target Groups
const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) {
      TARGET_GROUPS.push({ id: parts[0].trim(), name: parts.slice(1).join(':').trim() });
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
  if (isNaN(userId)) return { error: '❌ รูปแบบไม่ถูกต้อง ใช้ <code>@username</code> หรือ <code>ตัวเลข ID</code>' };
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
    const name = `${member.user.first_name || ''} ${member.user.last_name || ''}`.trim() || member.user.username || `ID:${userId}`;
    usernameCache[`id_${userId}`] = { id: userId, name };
    return name;
  } catch (e) { return `ID:${userId}`; }
}

// ==========================================
// 1. เมนูหลัก Command Center (ระบบจอทีวี - Admin Only)
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
  // [เพิ่มใหม่] ปุ่มเมนูตั้งค่าการรับรูปสำหรับแอดมิน
  keyboard.push([
    { text: `📸 ศูนย์ตั้งค่าภาพนิรนาม`, callback_data: `admin_settings` }
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
  const group = TARGET_GROUPS.find(g => g.id == groupId); 
  if (!group) return;
  const submenu = [
    [{ text: '🔴 ล้างบางเผ่าพันธุ์ (Ban)', callback_data: `opt_ban_${groupId}` }, { text: '🟢 ชุบชีวิตเนื้อเยื่อ (Unban)', callback_data: `opt_unban_${groupId}` }],
    [{ text: '☢️ ฉีดรังสีพิษ (Warn)', callback_data: `opt_warn_${groupId}` }, { text: '🧬 ล้างพิษดีเอ็นเอ (Unwarn)', callback_data: `opt_unwarn_${groupId}` }],
    [{ text: '🔬 สแกนระดับรังสี (Warn Status)', callback_data: `opt_warncheck_${groupId}` }],
    [{ text: '🧲 ดูดสื่อไร้ร่องรอย (Stealth)', callback_data: `cmd_capture_url_${groupId}` }, { text: '📡 ยิงคลื่นประกาศ (Transmit)', callback_data: `opt_ann_${groupId}` }],
    [{ text: '💬 ตอบกลับด้วยลิงก์ (Reply Link)', callback_data: `opt_replylink_${groupId}` }],
    [{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]
  ];
  bot.editMessageText(`🛰️ <b>พิกัดเซกเตอร์ที่ล็อกไว้:</b> <code>${group.name}</code>\nโปรดเลือกคำสั่งโปรโตคอลการโจมตี:`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  }).catch(()=>{});
}

// ==========================================
// 2. จัดการข้อความและโปรเซสเซสชัน (ผสาน Member + Admin)
// ==========================================
bot.on('message', async (msg) => {
  // บันทึกโปรไฟล์ Cache
  if (msg.from) {
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
    usernameCache[`id_${msg.from.id}`] = { id: msg.from.id, name: fullName };
    if (msg.from.username) usernameCache[msg.from.username.toLowerCase()] = { id: msg.from.id, name: fullName };
  }

  // 🛡️ ทำงานเฉพาะในแชทส่วนตัวเท่านั้น
  if (msg.chat.type !== 'private') return; 

  const numUserId = msg.from.id;
  const userId = numUserId.toString();
  const isAdmin = WHITELIST_IDS.includes(numUserId);

  // --- 2.1 ตรวจสอบสถานะรอรับรูปจากผู้ใช้ (Member/Admin) ---
  if (userStates[userId] === 'waiting_for_photo') {
    if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      
      // บันทึกลง MongoDB
      const newPhoto = new PendingPhoto({ file_id: fileId, sender_id: userId });
      const savedPhoto = await newPhoto.save();
      const photoDbId = savedPhoto._id.toString();

      await bot.sendMessage(msg.chat.id, "✅ <b>ส่งรูปภาพเรียบร้อยแล้ว</b> ระบบส่งให้แอดมินพิจารณาแล้วครับ\n<i>(พิมพ์ /start เพื่อเรียกเมนูใหม่)</i>", { parse_mode: 'HTML' });
      delete userStates[userId]; // เคลียร์สถานะ

      // แจ้งเตือนแอดมินทุกคน
      for (const adminId of WHITELIST_IDS) {
        try {
          await bot.sendPhoto(adminId, fileId, {
            caption: `🚨 <b>[สัญญาณแทรกซึม] มีรูปใหม่เข้าคิว!</b>\n\n👤 จากต้นทาง ID: <code>${userId}</code>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ อนุมัติ (ยิงเข้ากลุ่ม)", callback_data: `approve_${photoDbId}` }],
                [{ text: "❌ ปฏิเสธ (สลายรูปทิ้ง)", callback_data: `reject_${photoDbId}` }]
              ]
            }
          });
        } catch (e) {}
      }
      return;
    } else if (msg.text && msg.text.startsWith('/start')) {
      delete userStates[userId]; // ยกเลิกการส่งรูปถ้ากด Start ใหม่
    } else {
      await bot.sendMessage(msg.chat.id, "❌ กรุณาส่งเป็นไฟล์รูปภาพเท่านั้นครับ หากต้องการยกเลิกให้พิมพ์ /start");
      return;
    }
  }

  // --- 2.2 จัดการคำสั่ง /start (แยกระหว่าง Admin กับ Member) ---
  if (msg.text && msg.text.startsWith('/start')) {
    if (isAdmin) {
      monitorSessions.delete(numUserId);
      sendMainMenu(msg.chat.id);
    } else {
      // เมนูของ Member (มีปุ่มเดียว)
      bot.sendMessage(msg.chat.id, "สวัสดีครับ 🎭\nหากคุณต้องการแบ่งปันรูปภาพ สามารถกดปุ่มด้านล่างเพื่อส่งแบบไม่ระบุตัวตนให้แอดมินได้เลยครับ", {
        reply_markup: {
          inline_keyboard: [[{ text: "📸 ส่งรูปแบบไม่ระบุตัวตน", callback_data: "send_anonymous" }]]
        }
      });
    }
    return;
  }

  // --- 2.3 ระบบ Command Center ของ Admin (รอรับข้อความ) ---
  if (!isAdmin) return; 

  const session = monitorSessions.get(numUserId);
  if (!session) return;
  if (!msg.text && session.action !== 'ann') return;

  const { chatId, messageId, groupId, action } = session;
  const targetGroupId = groupId; 
  const groupObj = TARGET_GROUPS.find(g => g.id == targetGroupId);
  const groupName = groupObj ? groupObj.name : 'ไม่ระบุกลุ่ม';
  const inputStr = msg.text ? msg.text.trim() : '';

  if (action !== 'ann') bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

  let targetInput = '', reason = '', spaceIdx = -1, resolved, targetUserId, targetName;

  switch (action) {
    case 'capture_url':
      apiCounter++; await saveDailyData();
      bot.editMessageText(`⏳ <b>[QUANTUM TRACTOR BEAM]</b>\nกำลังเดินเครื่อง... โปรดรอสักครู่`, { chat_id: chatId, messageId: messageId, parse_mode: 'HTML' }).catch(()=>{});
      monitorSessions.delete(numUserId);
      try {
        let tChatId, mId;
        const parts = inputStr.split('/');
        mId = parseInt(parts.pop());
        tChatId = inputStr.includes('/c/') ? "-100" + parts.pop() : "@" + parts.pop();
        if (!tChatId || isNaN(mId)) throw new Error("พิกัดคลื่นไม่ถูกต้อง");
        apiCounter += 2; await saveDailyData();
        await bot.copyMessage(numUserId, tChatId, mId);
        bot.editMessageText(`🛸 <b>ดึงสื่อสำเร็จ</b>\nระบบส่งเข้าแชทส่วนตัวแล้ว`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {
        bot.editMessageText(`❌ <b>ดึงสื่อไม่สำเร็จ:</b> <code>${e.message}</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'warn':
    case 'ban':
    case 'unban':
    case 'unwarn':
    case 'warncheck':
      apiCounter++; await saveDailyData();
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ละเมิดกฎกองทัพเอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { 
        bot.editMessageText(`${resolved.error}`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        monitorSessions.delete(numUserId);
        setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 3000);
        break; 
      }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);
      monitorSessions.delete(numUserId);

      if (action === 'ban') {
        try {
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId); await saveDailyData();
          bot.sendMessage(targetGroupId, `🔴 <b>[ BAN VAPORIZED ]</b>\n👤 <b>เป้าหมาย:</b> ${targetName}\n🚨 สาเหตุ: <code>${reason}</code>`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ BAN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้า: ${targetName}\nเหตุ: ${reason}`);
          bot.editMessageText(`✅ <b>สลายร่างเหยื่อสำเร็จ (Ban)</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } catch (e) { bot.editMessageText(`⚠️ <b>แบนไม่สำเร็จ:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      } 
      else if (action === 'unban') {
        try {
          await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
          bot.sendMessage(targetGroupId, `🟢 <b>[ UNBAN REANIMATED ]</b>\n👤 <b>เป้าหมาย:</b> ${targetName}\n🔓 ได้รับอนุญาตให้กลับเข้ากลุ่ม`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ UNBAN LOG ]</b>\nกลุ่ม: ${groupName}\nเป้า: ${targetName}`);
          bot.editMessageText(`✅ <b>ชุบชีวิตเนื้อเยื่อสำเร็จ (Unban)</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } catch (e) { bot.editMessageText(`⚠️ <b>ปลดแบนไม่สำเร็จ:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      }
      else if (action === 'warn') {
        const currentWarn = addWarn(targetGroupId, targetUserId); await saveDailyData();
        const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);
        if (currentWarn >= WARN_LIMIT) {
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId); await saveDailyData();
          bot.sendMessage(targetGroupId, `☢️ <b>[ AUTO BAN ]</b>\n👤 ${targetName}\n☢️ รังสี: [${warnBar}]\n💥 สาเหตุ: ${reason}`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.editMessageText(`☢️ <b>Warn ครบ แบนอัตโนมัติสำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        } else {
          bot.sendMessage(targetGroupId, `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 ${targetName}\n☢️ รังสี: [${warnBar}]\n⚠️ สาเหตุ: ${reason}\n🚨 เหลือโอกาส ${WARN_LIMIT - currentWarn} ครั้ง`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
          bot.editMessageText(`☢️ <b>Warn สำเร็จ [${currentWarn}/${WARN_LIMIT}]</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
        }
      }
      else if (action === 'unwarn') {
        const newWarn = removeWarn(targetGroupId, targetUserId); await saveDailyData();
        bot.sendMessage(targetGroupId, `🧬 <b>[ DNA DETOX ]</b>\n👤 ${targetName}\n☢️ รังสีลดลงเหลือ: [${newWarn}/${WARN_LIMIT}]`, { parse_mode: 'HTML' }).then(m => setTimeout(()=>bot.deleteMessage(targetGroupId, m.message_id).catch(()=>{}), 60000));
        bot.editMessageText(`🧬 <b>ถอนพิษ Unwarn สำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      }
      else if (action === 'warncheck') {
        const currentW = getWarnCount(targetGroupId, targetUserId);
        bot.editMessageText(`🔬 <b>สแกน:</b> ${targetName}\n☢️ <b>รังสี:</b> [${currentW}/${WARN_LIMIT}]`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `select_group_${groupId}` }]] }}).catch(()=>{});
        return; // ไม่ต้อง setTimeout กลับไปหน้าเมนู
      }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'replylink':
      apiCounter++; await saveDailyData();
      monitorSessions.delete(numUserId);
      try {
        spaceIdx = inputStr.indexOf(' ');
        const url = inputStr.substring(0, spaceIdx).trim();
        const replyText = inputStr.substring(spaceIdx).trim();
        const mId = parseInt(url.split('/').pop());
        await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        bot.editMessageText(`📡 <b>ยิงคลื่นสัญญาณตอบกลับสำเร็จ!</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) { bot.editMessageText(`❌ <b>ขัดข้อง:</b> ${e.message}`, { chat_id: chatId, message_id: messageId }).catch(()=>{}); }
      setTimeout(() => { restoreSubmenu(chatId, messageId, groupId); }, 2500);
      break;

    case 'ann':
      apiCounter += 2; await saveDailyData();
      monitorSessions.delete(numUserId);
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
  const numUserId = query.from.id;
  const userId = numUserId.toString();
  const isAdmin = WHITELIST_IDS.includes(numUserId);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // --- 3.1 ฟังก์ชันของ Member: กดเพื่อส่งรูปแบบไม่ระบุตัวตน ---
  if (data === 'send_anonymous') {
    if (!appSettings.isAcceptingPhotos) {
      return bot.answerCallbackQuery(query.id, { text: "❌ ขณะนี้ศูนย์บังคับการปิดรับรูปภาพชั่วคราวครับ", show_alert: true });
    }
    userStates[userId] = 'waiting_for_photo';
    bot.sendMessage(chatId, "📸 <b>ส่งรูปภาพของคุณมาได้เลยครับ!</b>\n\nระบบจะปกปิดตัวตนของคุณเป็นความลับ", { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  // 🛡️ --- [กำแพงป้องกัน] --- หากไม่ใช่แอดมิน ห้ามกดปุ่มที่เหลือเด็ดขาด
  if (!isAdmin) {
    apiCounter++; saveDailyData();
    return bot.answerCallbackQuery(query.id, { text: '🚨 ปฏิเสธการเข้าถึง! โครงข่ายไม่รู้จักรหัสสัญญาณของคุณ', show_alert: true });
  }

  // --- 3.2 ฟังก์ชันใหม่ของ Admin: จัดการรูปภาพนิรนาม ---
  if (data.startsWith('approve_') || data.startsWith('reject_')) {
    const action = data.split('_')[0];
    const photoId = data.split('_')[1];

    try {
      const photoRecord = await PendingPhoto.findById(photoId);
      if (!photoRecord || photoRecord.status !== 'pending') {
        bot.answerCallbackQuery(query.id, { text: "⚠️ ไม่พบข้อมูลรูปนี้ หรือถูกจัดการไปแล้ว" });
        return bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      }

      if (action === 'approve') {
        const targetGroup = TARGET_GROUPS[0].id; // ส่งไปที่กลุ่มแรกเสมอ
        await bot.sendPhoto(targetGroup, photoRecord.file_id, {
          caption: "📩 <b>ภาพใหม่ถูกส่งเข้ามา!</b> (ไม่ระบุตัวตน)", parse_mode: 'HTML'
        });
        photoRecord.status = 'approved';
        await bot.editMessageCaption("✅ <b>อนุมัติแล้ว:</b> รูปถูกส่งเข้ากลุ่มสำเร็จ", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      } else {
        photoRecord.status = 'rejected';
        await bot.editMessageCaption("❌ <b>ปฏิเสธแล้ว:</b> รูปนี้ถูกทำลายทิ้ง", { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      }
      photoRecord.processed_by = userId;
      photoRecord.processed_at = new Date();
      await photoRecord.save();
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: "เกิดข้อผิดพลาดในการเข้าถึงฐานข้อมูล" });
    }
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'admin_settings' || data === 'toggle_accept_photos') {
    if (data === 'toggle_accept_photos') appSettings.isAcceptingPhotos = !appSettings.isAcceptingPhotos;
    
    const statusText = appSettings.isAcceptingPhotos ? "✅ <b>เปิด</b>รับภาพนิรนาม" : "❌ <b>ปิด</b>รับภาพนิรนาม";
    const toggleBtn = appSettings.isAcceptingPhotos ? "🔴 ปิดการรับภาพ" : "🟢 เปิดการรับภาพ";

    bot.editMessageText(`⚙️ <b>แผงตั้งค่า: ศูนย์รับภาพนิรนาม</b>\n\nสถานะปัจจุบัน: ${statusText}`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: toggleBtn, callback_data: "toggle_accept_photos" }],
          [{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]
        ]
      }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id, data === 'toggle_accept_photos' ? { text: "บันทึกการตั้งค่าแล้ว!" } : undefined);
  }

  // --- 3.3 ฟังก์ชันเดิมของ Admin: เมนูต่างๆ ---
  if (data.startsWith('cancel_')) {
    const groupId = data.replace('cancel_', '');
    monitorSessions.delete(numUserId);
    bot.answerCallbackQuery(query.id, { text: 'ยกเลิกคำสั่ง กลับสู่เมนู' });
    return restoreSubmenu(chatId, messageId, groupId);
  }

  if (data === 'back_to_main') {
    sendMainMenu(chatId, messageId);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'view_api_limits') {
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
    const bars = Math.round(pct / 10);
    const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
    bot.editMessageText(`📊 <b>เครื่องตรวจวัดพลังงานสัญญาณ</b>\nหลอด: [<code>${barStr}</code>] ${pct}%\nใช้ไป: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: 'back_to_main' }]] }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'view_whitelist') {
    let msgList = `👥 <b>รายชื่อโอเปอเรเตอร์ยานแม่</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ร่างอวตารนิรนาม";
      for (const key in usernameCache) if (usernameCache[key].id === id) { name = usernameCache[key].name; break; }
      msgList += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    bot.editMessageText(msgList, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: 'back_to_main' }]] }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('select_group_')) {
    const groupId = data.replace('select_group_', '');
    restoreSubmenu(chatId, messageId, groupId);
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('opt_') || data.startsWith('cmd_capture_url_')) {
    let action, groupId;
    if (data.startsWith('cmd_capture_url_')) {
      action = 'capture_url'; groupId = data.replace('cmd_capture_url_', '');
    } else {
      const parts = data.split('_'); action = parts[1]; groupId = parts[2];
    }
    const prompts = {
      'capture_url': '🧲 ป้อนลิงก์เป้าหมาย Telegram:',
      'ban': '🔴 ระบุเหยื่อ (รูปแบบ: @username หรือ ID):',
      'unban': '🟢 ระบุเป้าหมายปลดแบน (รูปแบบ: @username หรือ ID):',
      'warn': `☢️ ระบุเป้าหมายฉีดรังสี (ครบ ${WARN_LIMIT} = แบน):`,
      'unwarn': '🧬 ระบุเป้าหมายล้างพิษ 1 ครั้ง:',
      'warncheck': '🔬 ระบุเป้าหมายสแกนรังสีสะสม:',
      'ann': '📡 ส่งไฟล์ภาพ/ข้อความ เพื่อยิงเข้ากลุ่ม:',
      'replylink': '💬 ส่งลิงก์ ตามด้วยข้อความตอบกลับ:'
    };
    monitorSessions.set(numUserId, { chatId, messageId, groupId, action });
    bot.editMessageText(`<b>[ ${action.toUpperCase()} PROTOCOL ]</b>\n${prompts[action]}`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิกคำสั่ง', callback_data: `cancel_${groupId}` }]] }
    }).catch(()=>{});
    return bot.answerCallbackQuery(query.id);
  }
});

http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
