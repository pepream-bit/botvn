const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// ==========================================
// 🛡️ ตั้งค่า Environment & ตัวแปรหลัก
// ==========================================
const token = process.env.BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID
  ? (isNaN(process.env.LOG_CHANNEL_ID) ? process.env.LOG_CHANNEL_ID.trim() : parseInt(process.env.LOG_CHANNEL_ID.trim()))
  : null;

const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) TARGET_GROUPS.push({ id: parseInt(parts[0].trim()), name: parts.slice(1).join(':').trim() });
  });
}

if (!token || !mongoUri) {
  console.error('❌ CRITICAL ERROR: Environment Variables missing (BOT_TOKEN หรือ MONGODB_URI)!');
  process.exit(1);
}
if (!LOG_CHANNEL_ID) {
  console.error('❌ CRITICAL ERROR: LOG_CHANNEL_ID ไม่ถูกต้อง!');
  process.exit(1);
}
if (TARGET_GROUPS.length === 0) {
  console.error('❌ CRITICAL ERROR: TARGET_GROUPS ไม่ถูกต้อง!');
  process.exit(1);
}

// ==========================================
// 💽 โครงสร้างฐานข้อมูล MongoDB
// ==========================================

// 1. การตั้งค่าระดับโลก (Whitelist จัดการได้ผ่าน DB)
const GlobalConfigSchema = new mongoose.Schema({
  configId: { type: String, default: 'main' },
  whitelistIds: { type: [Number], default: [] }
});
const GlobalConfig = mongoose.model('GlobalConfig', GlobalConfigSchema);

// 2. การตั้งค่าและข้อมูลของแต่ละเซกเตอร์ (ถาวร)
const SectorConfigSchema = new mongoose.Schema({
  groupId: String,
  warnRecords: { type: Object, default: {} },         // { "userId": count }
  impersonatorNames: { type: [String], default: [] }, // รายชื่อมิจฉาชีพ
  settings: {
    storyBanActive: { type: Boolean, default: false },
    nameFilterActive: { type: Boolean, default: false },
    botMessageDeleteTime: { type: Number, default: 60000 }
  }
}, { minimize: false });
const SectorConfig = mongoose.model('SectorConfig', SectorConfigSchema);

// ==========================================
// 🌌 หน่วยความจำชั่วคราว (Cache & Session)
// ==========================================
let globalWhitelist = [];
const usernameCache = {};   // { "username_lower": { id, name } }
const sectorCache = {};     // { groupId: SectorConfig doc }
const monitorSessions = new Map();

const WARN_LIMIT = 2;

// ==========================================
// 🇹🇭 ระบบเวลาไทย
// ==========================================
function getThailandTimestamp() {
  return new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

// ==========================================
// ⚙️ ระบบจัดการข้อมูล (Data Management)
// ==========================================
async function loadDatabase() {
  try {
    // โหลด Whitelist จาก DB (ใช้ .env เป็นค่าตั้งต้นถ้ายังไม่มี)
    let gConfig = await GlobalConfig.findOne({ configId: 'main' });
    if (!gConfig) {
      const initialIds = process.env.WHITELIST_IDS
        ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n))
        : [];
      gConfig = await GlobalConfig.create({ configId: 'main', whitelistIds: initialIds });
      console.log(`👥 สร้าง Whitelist ใหม่จาก .env: ${initialIds.join(', ')}`);
    }
    globalWhitelist = gConfig.whitelistIds;

    // โหลดค่าของแต่ละกลุ่ม
    for (const group of TARGET_GROUPS) {
      let config = await SectorConfig.findOne({ groupId: group.id.toString() });
      if (!config) {
        config = await SectorConfig.create({
          groupId: group.id.toString(),
          warnRecords: {},
          impersonatorNames: [],
          settings: {}
        });
      }
      sectorCache[group.id] = config;
    }
    console.log('📂 โหลดข้อมูลเข้าสู่หน่วยความจำเสร็จสิ้น');
  } catch (e) {
    console.error('❌ โหลดข้อมูล DB ล้มเหลว:', e.message);
  }
}

async function saveGlobalConfig() {
  try {
    await GlobalConfig.findOneAndUpdate(
      { configId: 'main' },
      { whitelistIds: globalWhitelist },
      { upsert: true }
    );
  } catch (e) {
    console.error('❌ บันทึก GlobalConfig ล้มเหลว:', e.message);
  }
}

async function saveSectorData(groupId) {
  try {
    if (sectorCache[groupId]) {
      const data = sectorCache[groupId];
      await SectorConfig.findOneAndUpdate(
        { groupId: groupId.toString() },
        {
          warnRecords: data.warnRecords,
          impersonatorNames: data.impersonatorNames,
          settings: data.settings
        },
        { upsert: true }
      );
    }
  } catch (e) {
    console.error('❌ บันทึก Sector data ล้มเหลว:', e.message);
  }
}

// ==========================================
// 🔧 Utility Functions
// ==========================================
function getDeleteTime(groupId) {
  return sectorCache[groupId]?.settings?.botMessageDeleteTime ?? 60000;
}

function getWarnCount(groupId, userId) {
  return sectorCache[groupId]?.warnRecords?.[userId] || 0;
}

function addWarn(groupId, userId) {
  if (!sectorCache[groupId].warnRecords) sectorCache[groupId].warnRecords = {};
  sectorCache[groupId].warnRecords[userId] = (sectorCache[groupId].warnRecords[userId] || 0) + 1;
  return sectorCache[groupId].warnRecords[userId];
}

function removeWarn(groupId, userId) {
  if (!sectorCache[groupId]?.warnRecords?.[userId]) return 0;
  sectorCache[groupId].warnRecords[userId] = Math.max(0, sectorCache[groupId].warnRecords[userId] - 1);
  return sectorCache[groupId].warnRecords[userId];
}

function clearWarn(groupId, userId) {
  if (!sectorCache[groupId].warnRecords) sectorCache[groupId].warnRecords = {};
  sectorCache[groupId].warnRecords[userId] = 0;
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
  for (const key in usernameCache) {
    if (usernameCache[key].id === userId) return usernameCache[key].name;
  }
  try {
    const member = await bot.getChatMember(groupId, userId);
    const u = member.user;
    const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username || `ID:${userId}`;
    usernameCache[`id_${userId}`] = { id: userId, name };
    if (u.username) usernameCache[u.username.toLowerCase()] = { id: userId, name };
    return name;
  } catch {
    return `ID:${userId}`;
  }
}

function buildMessageLink(chatId, messageId) {
  const strId = chatId.toString();
  if (strId.startsWith('-100')) return `https://t.me/c/${strId.replace('-100', '')}/${messageId}`;
  if (strId.startsWith('@')) return `https://t.me/${strId.replace('@', '')}/${messageId}`;
  return null;
}

// ==========================================
// 🤖 สร้าง Bot Instance
// ==========================================
mongoose.connect(mongoUri)
  .then(() => {
    console.log('💽 Nebula Database Connected!');
    loadDatabase();
  })
  .catch(err => { console.error('❌ DB Error:', err.message); process.exit(1); });

const bot = new TelegramBot(token, { polling: true });
console.log('🛸 บอท Alien Invasion พร้อมลุยในอวกาศแล้ว!');

bot.on('polling_error', (err) => {
  console.error('❌ Polling Error:', err.message);
  if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
    console.error('💀 Conflict detected — forcing exit เพื่อให้ Render restart ใหม่');
    process.exit(1);
  }
});

async function sendSystemLog(message) {
  if (!LOG_CHANNEL_ID) return;
  try {
    await bot.sendMessage(LOG_CHANNEL_ID, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('❌ ส่ง Log ล้มเหลว:', err.message);
  }
}

// ==========================================
// 📺 ระบบ UI เมนูหน้าจอ
// ==========================================
function sendMainMenu(chatId) {
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);
  keyboard.push([{ text: `👥 จัดการ Whitelist`, callback_data: `menu_whitelist` }]);
  keyboard.push([{ text: `❌ ปิดแผงควบคุม`, callback_data: `close_main_menu` }]);
  bot.sendMessage(chatId, '🛸 <b>แผงควบคุมหลัก (Alien Command)</b>\nโปรดเลือกพิกัดเซกเตอร์:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  });
}

function sendWhitelistMenu(chatId) {
  const wlText = globalWhitelist.length > 0
    ? globalWhitelist.map((id, i) => {
        let name = 'ผู้ใช้นิรนาม';
        for (const key in usernameCache) {
          if (usernameCache[key].id === id) { name = usernameCache[key].name; break; }
        }
        return `${i + 1}. 🆔 <code>${id}</code> [${name}]`;
      }).join('\n')
    : '<i>ไม่มีข้อมูล</i>';
  const submenu = [
    [
      { text: '➕ เพิ่ม Admin', callback_data: `opt_addwl_global` },
      { text: '➖ ลบ Admin', callback_data: `opt_delwl_global` }
    ],
    [{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId,
    `👥 <b>ระบบจัดการผู้ควบคุม (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n${wlText}\n━━━━━━━━━━━━━━━━━━━━`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

function sendGroupMenu(chatId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  const submenu = [
    [{ text: '🛡️ ลงทัณฑ์ (Security)', callback_data: `menu_sec_${groupId}` }],
    [{ text: '🕵️ คัดกรองชื่อ (Name Filter)', callback_data: `menu_namefilter_${groupId}` }],
    [{ text: '📡 สื่อสาร (Comms)', callback_data: `menu_comms_${groupId}` }],
    [{ text: '⚙️ ตั้งค่า (Settings)', callback_data: `menu_set_${groupId}` }],
    [{ text: '⬅️ กลับหน้าจอหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId, `🛰️ <b>เซกเตอร์:</b> <code>${group.name}</code>\nเลือกระบบปฏิบัติการ:`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

function sendSecurityMenu(chatId, groupId) {
  const sector = sectorCache[groupId];
  if (!sector) return;
  const isStoryOn = sector.settings.storyBanActive;
  const submenu = [
    [
      { text: '🔴 ล้างบาง (Ban)', callback_data: `opt_ban_${groupId}` },
      { text: '🟢 ชุบชีวิต (Unban)', callback_data: `opt_unban_${groupId}` }
    ],
    [
      { text: '☢️ ฉีดรังสี (Warn)', callback_data: `opt_warn_${groupId}` },
      { text: '🧬 ล้างพิษ (Unwarn)', callback_data: `opt_unwarn_${groupId}` }
    ],
    [{ text: '🔬 สแกนรังสี (Warn Status)', callback_data: `opt_warncheck_${groupId}` }],
    [{ text: isStoryOn ? '🟢 StoryBan: ON' : '🔴 StoryBan: OFF', callback_data: `toggle_storyban_${groupId}` }],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId,
    `🛡️ <b>ระบบลงทัณฑ์และความปลอดภัย</b>\n🛰️ เซกเตอร์: <code>${TARGET_GROUPS.find(g => g.id == groupId)?.name}</code>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

function sendNameFilterMenu(chatId, groupId) {
  const sector = sectorCache[groupId];
  if (!sector) return;
  const isNameOn = sector.settings.nameFilterActive;
  const names = sector.impersonatorNames.length > 0
    ? sector.impersonatorNames.map((n, i) => `${i + 1}. <code>${n}</code>`).join('\n')
    : '<i>ไม่มีข้อมูล</i>';
  const submenu = [
    [{ text: isNameOn ? '🟢 NameFilter: ON' : '🔴 NameFilter: OFF', callback_data: `toggle_namefilter_${groupId}` }],
    [
      { text: '➕ เพิ่มชื่อ', callback_data: `opt_addname_${groupId}` },
      { text: '➖ ลบชื่อ', callback_data: `opt_delname_${groupId}` }
    ],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId,
    `🕵️ <b>ระบบคัดกรองมิจฉาชีพ (Impersonator Filter)</b>\nหากชื่อมีคำเหล่านี้ จะถูกแบนทันที\n\n<b>รายชื่อเฝ้าระวัง:</b>\n${names}`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

function sendCommsMenu(chatId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  if (!group) return;
  const submenu = [
    [
      { text: '🧲 ดูดสื่อ (Stealth)', callback_data: `opt_capture_${groupId}` },
      { text: '📡 ประกาศ (Transmit)', callback_data: `opt_ann_${groupId}` }
    ],
    [
      { text: '💬 ตอบด้วยลิงก์ (Reply)', callback_data: `opt_replylink_${groupId}` },
      { text: '🚀 ทางลัด (Jump)', callback_data: `opt_quickjump_${groupId}` }
    ],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId, `📡 <b>ระบบสื่อสารดาวเทียม</b>\n🛰️ เซกเตอร์: <code>${group.name}</code>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

function sendSettingsMenu(chatId, groupId) {
  const sector = sectorCache[groupId];
  if (!sector) return;
  const t = sector.settings.botMessageDeleteTime;
  const tText = t === 0 ? '🛑 ไม่ลบ' : `${t / 1000} วินาที`;
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
  bot.sendMessage(chatId,
    `⚙️ <b>ตั้งค่าระยะเวลาลบข้อความบอทอัตโนมัติ</b>\n🛰️ เซกเตอร์: <code>${TARGET_GROUPS.find(g => g.id == groupId)?.name}</code>\nค่าปัจจุบัน: <code>${tText}</code>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

bot.onText(/\/start/, (msg) => {
  if (!globalWhitelist.includes(msg.from.id)) return;
  monitorSessions.delete(msg.from.id);
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 🔘 ระบบปุ่มกด (Callback Query)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!globalWhitelist.includes(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'ปฏิเสธคำสั่ง! ไม่อยู่ใน Whitelist', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});
  bot.deleteMessage(chatId, messageId).catch(() => {});

  // ── Navigation ──
  if (data === 'back_to_main') return sendMainMenu(chatId);
  if (data === 'close_main_menu') return;
  if (data === 'menu_whitelist') return sendWhitelistMenu(chatId);
  if (data.startsWith('select_group_')) return sendGroupMenu(chatId, data.replace('select_group_', ''));
  if (data.startsWith('menu_sec_')) return sendSecurityMenu(chatId, data.replace('menu_sec_', ''));
  if (data.startsWith('menu_namefilter_')) return sendNameFilterMenu(chatId, data.replace('menu_namefilter_', ''));
  if (data.startsWith('menu_comms_')) return sendCommsMenu(chatId, data.replace('menu_comms_', ''));
  if (data.startsWith('menu_set_')) return sendSettingsMenu(chatId, data.replace('menu_set_', ''));

  // ── Toggle Switches ──
  if (data.startsWith('toggle_storyban_')) {
    const groupId = data.replace('toggle_storyban_', '');
    sectorCache[groupId].settings.storyBanActive = !sectorCache[groupId].settings.storyBanActive;
    await saveSectorData(groupId);
    return sendSecurityMenu(chatId, groupId);
  }
  if (data.startsWith('toggle_namefilter_')) {
    const groupId = data.replace('toggle_namefilter_', '');
    sectorCache[groupId].settings.nameFilterActive = !sectorCache[groupId].settings.nameFilterActive;
    await saveSectorData(groupId);
    return sendNameFilterMenu(chatId, groupId);
  }

  // ── ตั้งเวลาลบ ──
  if (data.startsWith('set_del_')) {
    const parts = data.split('_');
    const groupId = parts[2];
    const timeVal = parseInt(parts[3]);
    sectorCache[groupId].settings.botMessageDeleteTime = timeVal;
    await saveSectorData(groupId);
    return sendSettingsMenu(chatId, groupId);
  }

  // ── คำสั่ง action (opt_) ──
  if (data.startsWith('opt_')) {
    let action, groupId;

    // Whitelist actions มี format ต่างออกไป: opt_addwl_global / opt_delwl_global
    if (data === 'opt_addwl_global' || data === 'opt_delwl_global') {
      action = data === 'opt_addwl_global' ? 'addwl' : 'delwl';
      groupId = 'global';
    } else {
      const parts = data.split('_');
      action = parts[1];
      groupId = parts[2];
    }

    const backTarget = groupId === 'global' ? 'menu_whitelist' : `select_group_${groupId}`;
    const cancelMenu = { inline_keyboard: [[{ text: '❌ ยกเลิกและกลับ', callback_data: backTarget }]] };

    let promptMsg = `⌨️ <b>รอรับข้อมูลคำสั่ง [${action.toUpperCase()}]</b>\nโปรดพิมพ์ส่งเข้ามาที่แชทนี้...`;
    if (action === 'ban')       promptMsg = `🔴 <b>[BAN PROTOCOL]</b>\nระบุเป้าหมาย:\n<code>@username เหตุผล</code> หรือ <code>ID เหตุผล</code>`;
    if (action === 'unban')     promptMsg = `🟢 <b>[UNBAN PROTOCOL]</b>\nระบุเป้าหมาย:\n<code>@username เหตุผล</code> หรือ <code>ID เหตุผล</code>`;
    if (action === 'warn')      promptMsg = `☢️ <b>[RADIATION WARN]</b>\nระบุเป้าหมาย (ครบ ${WARN_LIMIT} ครั้ง = AUTO-BAN):\n<code>@username เหตุผล</code> หรือ <code>ID เหตุผล</code>`;
    if (action === 'unwarn')    promptMsg = `🧬 <b>[DETOX UNWARN]</b>\nระบุเป้าหมายที่จะล้างค่าเตือน 1 ขั้น:\n<code>@username</code> หรือ <code>ID</code>`;
    if (action === 'warncheck') promptMsg = `🔬 <b>[RADIATION SCANNER]</b>\nระบุเป้าหมายที่จะสแกน:\n<code>@username</code> หรือ <code>ID</code>`;
    if (action === 'ann')       promptMsg = `📡 <b>[BEAM TRANSMISSION]</b>\nส่งข้อความ รูปภาพ ไฟล์ หรือวิดีโอที่ต้องการประกาศ:`;
    if (action === 'capture')   promptMsg = `🧲 <b>[STEALTH CAPTURE]</b>\nส่งลิงก์ข้อความ Telegram:\n<code>https://t.me/c/xxxx/xxxx</code>`;
    if (action === 'replylink') promptMsg = `💬 <b>[REPLY LINK]</b>\nรูปแบบ: <code>[ลิงก์ข้อความ] [คำตอบกลับ]</code>`;
    if (action === 'quickjump') promptMsg = `🚀 <b>[QUICK JUMP]</b>\nส่งลิงก์ข้อความที่ต้องการสร้างปุ่มทางลัด:`;
    if (action === 'addname')   promptMsg = `➕ <b>[เพิ่มชื่อเฝ้าระวัง]</b>\nพิมพ์ชื่อหรือคำที่ต้องการเพิ่ม (เช่น <code>THEWORLD V2</code>):`;
    if (action === 'delname')   promptMsg = `➖ <b>[ลบชื่อเฝ้าระวัง]</b>\nพิมพ์ชื่อหรือคำที่ต้องการลบออก (ต้องตรงกับในระบบ):`;
    if (action === 'addwl')     promptMsg = `➕ <b>[เพิ่ม Admin]</b>\nพิมพ์ <b>ID ตัวเลข</b> ของผู้ที่ต้องการตั้งเป็น Admin:`;
    if (action === 'delwl')     promptMsg = `➖ <b>[ลบ Admin]</b>\nพิมพ์ <b>ID ตัวเลข</b> ของผู้ที่ต้องการปลดจาก Admin:`;

    bot.sendMessage(chatId, promptMsg, { parse_mode: 'HTML', reply_markup: cancelMenu })
      .then(sentMsg => {
        monitorSessions.set(query.from.id, { chatId, groupId, action, promptMsgId: sentMsg.message_id });
      });
  }
});

// ==========================================
// 💬 ระบบรับข้อความหลัก (Main Engine)
// ==========================================
bot.on('message', async (msg) => {
  if (!msg.from) return;

  // บันทึก username cache ทุกข้อความ
  const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `ID:${msg.from.id}`;
  usernameCache[`id_${msg.from.id}`] = { id: msg.from.id, name: fullName };
  if (msg.from.username) {
    usernameCache[msg.from.username.toLowerCase().replace('@', '')] = { id: msg.from.id, name: fullName };
  }

  const isTargetGroup = TARGET_GROUPS.some(g => g.id === msg.chat.id);
  const currentSector = sectorCache[msg.chat.id];

  // 🛡️ [AUTO DEFENSE] ทำงานเฉพาะในกลุ่มเป้าหมาย ไม่ใช่ Whitelist
  if (isTargetGroup && currentSector && !globalWhitelist.includes(msg.from.id)) {

    // 1. STORY BAN
    if (currentSector.settings.storyBanActive &&
        (msg.forward_from_chat || msg.forward_from || msg.story || msg.forward_date)) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      bot.banChatMember(msg.chat.id, msg.from.id).catch(() => {});
      await sendSystemLog(
        `👻 <b>[STORYBAN TRIGGERED]</b>\nเป้าหมาย: <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>)\nเซกเตอร์: <code>${msg.chat.title || msg.chat.id}</code>\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`
      );
      return;
    }

    // 2. NAME FILTER BAN
    if (currentSector.settings.nameFilterActive && currentSector.impersonatorNames.length > 0) {
      const senderName = fullName.toLowerCase();
      const isMijji = currentSector.impersonatorNames.some(bName => senderName.includes(bName.toLowerCase()));
      if (isMijji) {
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        bot.banChatMember(msg.chat.id, msg.from.id).catch(() => {});
        await sendSystemLog(
          `🚫 <b>[NAME FILTER BAN]</b>\nเป้าหมาย: <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>)\nเซกเตอร์: <code>${msg.chat.title || msg.chat.id}</code>\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`
        );
        return;
      }
    }
  }

  // 📺 [TV MODE] รับคำสั่งจาก Admin เท่านั้น
  if (!globalWhitelist.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  const session = monitorSessions.get(msg.from.id);
  if (!session) return;

  const { chatId, groupId, action, promptMsgId } = session;
  const targetGroupId = parseInt(groupId);
  const groupObj = TARGET_GROUPS.find(g => g.id === targetGroupId);
  const groupName = groupObj ? groupObj.name : 'ไม่ระบุกลุ่ม';
  const sector = sectorCache[groupId];
  const delTime = getDeleteTime(groupId);
  const inputStr = msg.text ? msg.text.trim() : '';

  // ลบข้อความที่พิมพ์เข้ามา (ยกเว้น ann ที่ต้องใช้ข้อความนั้น)
  if (action !== 'ann') bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  if (promptMsgId) bot.deleteMessage(chatId, promptMsgId).catch(() => {});
  monitorSessions.delete(msg.from.id);

  const finishMenu = { inline_keyboard: [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]] };
  const finishMenuWL = { inline_keyboard: [[{ text: '⬅️ กลับสู่ Whitelist', callback_data: `menu_whitelist` }]] };

  let targetInput, reason, spaceIdx, resolved, targetUserId, targetName;

  switch (action) {

    // ── Whitelist Management ──
    case 'addwl': {
      const newId = parseInt(inputStr);
      if (isNaN(newId)) {
        bot.sendMessage(chatId, `❌ ID ต้องเป็นตัวเลขเท่านั้น`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
        break;
      }
      if (!globalWhitelist.includes(newId)) {
        globalWhitelist.push(newId);
        await saveGlobalConfig();
      }
      bot.sendMessage(chatId, `✅ เพิ่ม <code>${newId}</code> เข้าสู่ Whitelist แล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
      await sendSystemLog(`👥 <b>[WHITELIST ADD]</b>\nเพิ่ม ID: <code>${newId}</code>\nโดย: ${fullName} (<code>${msg.from.id}</code>)\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
      break;
    }
    case 'delwl': {
      const delId = parseInt(inputStr);
      if (isNaN(delId)) {
        bot.sendMessage(chatId, `❌ ID ต้องเป็นตัวเลขเท่านั้น`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
        break;
      }
      globalWhitelist = globalWhitelist.filter(id => id !== delId);
      await saveGlobalConfig();
      bot.sendMessage(chatId, `✅ ปลด <code>${delId}</code> ออกจาก Whitelist แล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
      await sendSystemLog(`👥 <b>[WHITELIST REMOVE]</b>\nลบ ID: <code>${delId}</code>\nโดย: ${fullName} (<code>${msg.from.id}</code>)\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
      break;
    }

    // ── NameFilter ──
    case 'addname': {
      if (!sector.impersonatorNames.includes(inputStr)) {
        sector.impersonatorNames.push(inputStr);
        await saveSectorData(groupId);
      }
      bot.sendMessage(chatId, `✅ เพิ่มคำว่า "<b>${inputStr}</b>" ลงในรายชื่อเฝ้าระวังแล้ว`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับหน้า Name Filter', callback_data: `menu_namefilter_${groupId}` }]] }
      });
      break;
    }
    case 'delname': {
      sector.impersonatorNames = sector.impersonatorNames.filter(n => n !== inputStr);
      await saveSectorData(groupId);
      bot.sendMessage(chatId, `✅ ลบคำว่า "<b>${inputStr}</b>" ออกจากรายชื่อเฝ้าระวังแล้ว`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับหน้า Name Filter', callback_data: `menu_namefilter_${groupId}` }]] }
      });
      break;
    }

    // ── Comms ──
    case 'ann': {
      try {
        const copiedMsg = await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, copiedMsg.message_id).catch(() => {}); }, delTime);

        const msgLink = buildMessageLink(targetGroupId, copiedMsg.message_id);
        const inlineKey = [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]];
        if (msgLink) inlineKey.unshift([{ text: '📢 เปิดดูข้อความประกาศ', url: msgLink }]);

        bot.sendMessage(chatId, `📡 <b>ส่งสัญญาณประกาศสำเร็จ!</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKey } });
      } catch (e) {
        bot.sendMessage(chatId, `❌ <b>ส่งประกาศล้มเหลว:</b> ${e.message}`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    case 'capture': {
      const loadingMsg = await bot.sendMessage(chatId, `⏳ <b>[STEALTH CAPTURE]</b> กำลังดึงสื่อ...`, { parse_mode: 'HTML' });
      try {
        let tChatId, mId;
        if (inputStr.includes('/c/')) {
          const parts = inputStr.split('/');
          mId = parseInt(parts.pop());
          tChatId = parseInt('-100' + parts.pop());
        } else {
          const parts = inputStr.split('/');
          mId = parseInt(parts.pop());
          tChatId = '@' + parts.pop();
        }
        if (!tChatId || isNaN(mId)) throw new Error('รูปแบบลิงก์ไม่ถูกต้อง');

        await bot.copyMessage(msg.from.id, tChatId, mId);
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `🛸 <b>ดึงสื่อสำเร็จ!</b> ส่งตรงไปยังกล่องข้อความของคุณแล้ว`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🔗 เปิดดูต้นทาง', url: inputStr }],
            [{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]
          ]}
        });
      } catch (e) {
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `❌ <b>ดึงสื่อล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    case 'replylink': {
      try {
        spaceIdx = inputStr.indexOf(' ');
        if (spaceIdx === -1) throw new Error('โปรดใส่ข้อความตอบกลับหลังลิงก์ เว้นวรรคคั่น');
        const url = inputStr.substring(0, spaceIdx).trim();
        const replyText = inputStr.substring(spaceIdx).trim();

        let tChatId, mId;
        if (url.includes('/c/')) {
          const parts = url.split('/'); mId = parseInt(parts.pop()); tChatId = parseInt('-100' + parts.pop());
        } else {
          const parts = url.split('/'); mId = parseInt(parts.pop()); tChatId = '@' + parts.pop();
        }
        if (!tChatId || isNaN(mId)) throw new Error('ลิงก์ข้อความไม่สมบูรณ์');

        const sentMsg = await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: mId });
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, sentMsg.message_id).catch(() => {}); }, delTime);

        const msgLink = buildMessageLink(targetGroupId, sentMsg.message_id);
        const inlineKey = [[{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]];
        if (msgLink) inlineKey.unshift([{ text: '💬 เปิดดูข้อความตอบกลับ', url: msgLink }]);

        bot.sendMessage(chatId, `📡 <b>ยิงสัญญาณตอบกลับสำเร็จ!</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKey } });
      } catch (e) {
        bot.sendMessage(chatId, `❌ <b>ยิงสัญญาณล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    case 'quickjump': {
      bot.sendMessage(chatId, `✅ <b>สร้างทางลัดสำเร็จ!</b>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🚀 พุ่งกระโดดไปยังพิกัด', url: inputStr }],
          [{ text: '⬅️ กลับสู่เมนูเซกเตอร์', callback_data: `select_group_${groupId}` }]
        ]}
      });
      break;
    }

    // ── Security ──
    case 'warn': {
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ฝ่าฝืนกฎระเบียบกองทัพเอเลี่ยน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { bot.sendMessage(chatId, resolved.error, { parse_mode: 'HTML', reply_markup: finishMenu }); break; }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      try {
        const currentWarn = addWarn(targetGroupId, targetUserId);
        await saveSectorData(groupId);
        const warnBar = buildWarnBar(currentWarn, WARN_LIMIT);

        if (currentWarn >= WARN_LIMIT) {
          await bot.banChatMember(targetGroupId, targetUserId);
          clearWarn(targetGroupId, targetUserId);
          await saveSectorData(groupId);

          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ RADIATION OVERLOAD - AUTO BAN ]</b>\n👤 <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีสะสม: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n💥 เหตุผล: <code>${reason}</code>\n☠️ AUTO-BAN ทันที`,
            { parse_mode: 'HTML' }
          );
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

          await sendSystemLog(`📜 <b>[ AUTO-BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nสาเหตุ: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
          bot.sendMessage(chatId, `☢️ <b>Warn ครบเกณฑ์ — AUTO-BAN สำเร็จ!</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
        } else {
          const rem = WARN_LIMIT - currentWarn;
          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีสะสม: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ เหตุผล: <code>${reason}</code>\n🚨 อีก <b>${rem} ครั้ง</b> จะถูก AUTO-BAN`,
            { parse_mode: 'HTML' }
          );
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

          await sendSystemLog(`📜 <b>[ WARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
          bot.sendMessage(chatId, `☢️ <b>Warn สำเร็จ [${currentWarn}/${WARN_LIMIT}]</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
        }
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>Warn ล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    case 'unwarn': {
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับอนุญาตจากยานแม่' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { bot.sendMessage(chatId, resolved.error, { parse_mode: 'HTML', reply_markup: finishMenu }); break; }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      const oldWarn = getWarnCount(targetGroupId, targetUserId);
      if (oldWarn === 0) {
        bot.sendMessage(chatId, `🧬 <b>เป้าหมายไม่มีค่ารังสีตกค้างอยู่แล้ว</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
        break;
      }

      try {
        const currentWarn = removeWarn(targetGroupId, targetUserId);
        await saveSectorData(groupId);
        const unwarnBar = buildWarnBar(currentWarn, WARN_LIMIT);

        const m = await bot.sendMessage(targetGroupId,
          `🧬 <b>[ DETOXIFICATION COMPLETE ]</b>\n👤 <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีคงเหลือ: [${unwarnBar}] ${currentWarn}/${WARN_LIMIT}\n💉 บันทึก: <code>${reason}</code>`,
          { parse_mode: 'HTML' }
        );
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

        await sendSystemLog(`📜 <b>[ UNWARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ${oldWarn} → ${currentWarn}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
        bot.sendMessage(chatId, `🧬 <b>Unwarn สำเร็จ!</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>Unwarn ล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    case 'warncheck': {
      targetInput = inputStr.split(' ')[0];
      resolved = resolveTarget(targetInput);
      if (resolved.error) { bot.sendMessage(chatId, resolved.error, { parse_mode: 'HTML', reply_markup: finishMenu }); break; }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      const checkWarn = getWarnCount(targetGroupId, targetUserId);
      const chkBar = buildWarnBar(checkWarn, WARN_LIMIT);
      const chkText = checkWarn === 0
        ? '✅ ปกติ ไม่มีสารพิษ'
        : checkWarn >= WARN_LIMIT
        ? '🚨 ระดับวิกฤต (ภายใต้โปรโตคอลแบน)'
        : '⚠️ มีประวัติสะสมรังสี';

      bot.sendMessage(chatId,
        `🔬 <b>[ BIO-SCANNER REPORT ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>ชื่อ:</b> ${targetName}\n🆔 <b>ID:</b> <code>${targetUserId}</code>\n🛰️ <b>เซกเตอร์:</b> ${groupName}\n☢️ <b>ดัชนีรังสี:</b> [${chkBar}] ${checkWarn}/${WARN_LIMIT}\n📊 <b>สถานะ:</b> ${chkText}\n━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML', reply_markup: finishMenu }
      );
      break;
    }

    case 'ban': {
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ตรวจพบพฤติกรรมเป็นภัยต่อกองยานแม่' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { bot.sendMessage(chatId, resolved.error, { parse_mode: 'HTML', reply_markup: finishMenu }); break; }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      try {
        await bot.banChatMember(targetGroupId, targetUserId);
        clearWarn(targetGroupId, targetUserId);
        await saveSectorData(groupId);

        const m = await bot.sendMessage(targetGroupId,
          `🔴 <b>[ PROTOCOL VAPORIZED - BAN ]</b>\n👤 <b>${targetName}</b> (🆔 <code>${targetUserId}</code>)\n🚨 ข้อหา: <code>${reason}</code>`,
          { parse_mode: 'HTML' }
        );
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

        await sendSystemLog(`📜 <b>[ BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nข้อหา: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
        bot.sendMessage(chatId, `✅ <b>BAN สำเร็จ</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>BAN ล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    case 'unban': {
      spaceIdx = inputStr.indexOf(' ');
      targetInput = spaceIdx === -1 ? inputStr : inputStr.substring(0, spaceIdx);
      reason = spaceIdx === -1 ? 'ได้รับการอภัยโทษจากผู้ควบคุมยาน' : inputStr.substring(spaceIdx + 1).trim();

      resolved = resolveTarget(targetInput);
      if (resolved.error) { bot.sendMessage(chatId, resolved.error, { parse_mode: 'HTML', reply_markup: finishMenu }); break; }
      targetUserId = resolved.userId;
      targetName = resolved.name || await resolveName(targetUserId, targetGroupId);

      try {
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });

        const m = await bot.sendMessage(targetGroupId,
          `🟢 <b>[ REANIMATE COMPLETE - UNBAN ]</b>\n👤 <b>${targetName}</b> (🆔 <code>${targetUserId}</code>)\n🔓 คืนสิทธิ์เข้ากลุ่มแล้ว`,
          { parse_mode: 'HTML' }
        );
        if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

        await sendSystemLog(`📜 <b>[ UNBAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nหมายเหตุ: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`);
        bot.sendMessage(chatId, `✅ <b>UNBAN สำเร็จ</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      } catch (e) {
        bot.sendMessage(chatId, `⚠️ <b>UNBAN ล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML', reply_markup: finishMenu });
      }
      break;
    }

    default:
      bot.sendMessage(chatId, `✅ รับคำสั่ง ${action} สำเร็จ`, { reply_markup: finishMenu });
  }
});

// 🌐 Web Server ป้องกัน Render Sleep
http.createServer((req, res) => res.end('ALIEN_STATION_ONLINE')).listen(process.env.PORT || 3000);
