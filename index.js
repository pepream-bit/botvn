const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

// ==========================================
// 👾 RPG Boss System — โหลด Controller
// ==========================================
const {
  getAllBosses, getBossById, createBoss, updateBoss, deleteBoss,
  getSpawnSettings, saveSpawnSettings, spawnBoss,
  checkAutoSpawn, incrementMessageCounter
} = require('./bossController');

const {
  awardTag, recordKill, checkExpiredTags, getPlayerStats
} = require('./tagController');

// ==========================================
// 🆕 ระบบคิวหน่วงเวลาอัจฉริยะ (Flood Wait Protection)
// ==========================================
class TelegramQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.delayBetweenTasks = 150; // หน่วงเวลาระหว่างคำสั่ง 150ms (ปรับเพิ่ม/ลดได้)
  }

  // ฟังก์ชันสำหรับส่งคำสั่งเข้าคิว
  add(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const { taskFn, resolve, reject } = this.queue.shift();

    try {
      const result = await taskFn();
      resolve(result);
    } catch (error) {
      // 🚨 ถ้าติด Flood Wait (Error 420) ให้หยุดรอตามวินาทีที่ Telegram สั่ง
      if (error.response && error.response.body && error.response.body.parameters) {
        const retryAfter = error.response.body.parameters.retry_after;
        if (retryAfter) {
          console.log(`⚠️ ติด Flood Wait! ระบบจะหยุดรอ ${retryAfter} วินาที ก่อนทำงานต่อ`);
          await new Promise(res => setTimeout(res, retryAfter * 1000));
          // เอาคำสั่งนี้ใส่กลับไปต้นคิวเพื่อทำงานใหม่อีกครั้ง
          this.queue.unshift({ taskFn, resolve, reject });
          this.isProcessing = false;
          this.processNext();
          return;
        }
      }
      reject(error);
    }

    // หน่วงเวลาสั้นๆ ก่อนไปทำคำสั่งถัดไป เพื่อกระจายโหลด
    await new Promise(res => setTimeout(res, this.delayBetweenTasks));
    this.isProcessing = false;
    this.processNext();
  }
}

// สร้างตัวเรียกใช้งานคิวกลาง
const tgQueue = new TelegramQueue();

// ==========================================
// 🛡️ ตั้งค่า Environment & ตัวแปรหลัก
// ==========================================
const token = process.env.BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID
  ? (isNaN(process.env.LOG_CHANNEL_ID) ? process.env.LOG_CHANNEL_ID.trim() : parseInt(process.env.LOG_CHANNEL_ID.trim()))
  : null;

if (!token || !mongoUri || !LOG_CHANNEL_ID) {
  console.error('❌ CRITICAL ERROR: Environment Variables missing (BOT_TOKEN, MONGODB_URI, หรือ LOG_CHANNEL_ID)!');
  process.exit(1);
}

// ==========================================
// 💽 โครงสร้างฐานข้อมูล MongoDB
// ==========================================

// 1. การตั้งค่าระดับโลก (Whitelist + Target Groups จัดการได้ผ่าน DB)
const GlobalConfigSchema = new mongoose.Schema({
  configId: { type: String, default: 'main' },
  whitelistIds: { type: [Number], default: [] },
  targetGroups: { type: [{ id: Number, name: String }], default: [] },
  botStatusNotifyActive: { type: Boolean, default: false },
  notifyUserIds: { type: [Number], default: [] }
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
    botMessageDeleteTime: { type: Number, default: 60000 },
    storyBanLogActive: { type: Boolean, default: false },    // เปิด/ปิด Log StoryBan
    nameFilterLogActive: { type: Boolean, default: false },  // เปิด/ปิด Log NameFilter
    logChannelId: { type: String, default: null }            // แชนแนลส่ง Log เฉพาะเซกเตอร์ (null = ใช้แชนแนลกลาง)
  }
}, { minimize: false });
const SectorConfig = mongoose.model('SectorConfig', SectorConfigSchema);

// ==========================================
// 🌌 หน่วยความจำชั่วคราว (Cache & Session)
// ==========================================
let globalWhitelist = [];
let TARGET_GROUPS = [];
let botStatusNotifyActive = false;
let notifyUserIds = [];
const usernameCache = {};   // { "username_lower": { id, name } }
const sectorCache = {};     // { groupId: SectorConfig doc }
const monitorSessions = new Map();

// session สำหรับระบบบอส (แยกจาก monitorSessions เพื่อไม่ให้ชนกัน)
const bossEditSessions = new Map(); // { userId: { action, bossId, field, chatId } }

// เก็บ messageId ของบอสที่เกิดอยู่ เพื่อลบปุ่มเมื่อถูกล่า
const activeBossMessages = new Map(); // { `${chatId}_${bossId}`: messageId }

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
    // โหลด Whitelist + Target Groups จาก DB (ใช้ .env เป็นค่าตั้งต้นถ้ายังไม่มี)
    let gConfig = await GlobalConfig.findOne({ configId: 'main' });
    if (!gConfig) {
      const initialIds = process.env.WHITELIST_IDS
        ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n))
        : [];
      const initialGroups = [];
      if (process.env.TARGET_GROUPS) {
        process.env.TARGET_GROUPS.split(',').forEach(item => {
          const parts = item.split(':');
          if (parts.length >= 2) initialGroups.push({ id: parseInt(parts[0].trim()), name: parts.slice(1).join(':').trim() });
        });
      }
      gConfig = await GlobalConfig.create({ 
        configId: 'main', 
        whitelistIds: initialIds,
        targetGroups: initialGroups 
      });
      console.log(`👥 สร้าง Whitelist ใหม่จาก .env: ${initialIds.join(', ')}`);
      console.log(`🛰️ สร้าง Target Groups ใหม่จาก .env: ${initialGroups.map(g => g.name).join(', ')}`);
    }
    globalWhitelist = gConfig.whitelistIds;
    TARGET_GROUPS = gConfig.targetGroups || [];
    botStatusNotifyActive = gConfig.botStatusNotifyActive || false;
    notifyUserIds = gConfig.notifyUserIds || [];

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
      sectorCache[group.id.toString()] = config;
    }
    console.log('📂 โหลดข้อมูลเข้าสู่หน่วยความจำเสร็จสิ้น');
    console.log('🗂️ sectorCache keys:', Object.keys(sectorCache));
    console.log('🛰️ TARGET_GROUPS ids:', TARGET_GROUPS.map(g => `${g.id} (${typeof g.id})`));
  } catch (e) {
    console.error('❌ โหลดข้อมูล DB ล้มเหลว:', e.message);
  }
}

async function saveGlobalConfig() {
  try {
    await GlobalConfig.findOneAndUpdate(
      { configId: 'main' },
      { whitelistIds: globalWhitelist, targetGroups: TARGET_GROUPS, botStatusNotifyActive, notifyUserIds },
      { upsert: true }
    );
  } catch (e) {
    console.error('❌ บันทึก GlobalConfig ล้มเหลว:', e.message);
  }
}

async function saveSectorData(groupId) {
  try {
    const key = groupId.toString();
    if (sectorCache[key]) {
      const data = sectorCache[key];
      await SectorConfig.findOneAndUpdate(
        { groupId: key },
        {
          $set: {
            warnRecords: data.warnRecords,
            impersonatorNames: data.impersonatorNames,
            'settings.storyBanActive': data.settings.storyBanActive,
            'settings.nameFilterActive': data.settings.nameFilterActive,
            'settings.botMessageDeleteTime': data.settings.botMessageDeleteTime,
            'settings.storyBanLogActive': data.settings.storyBanLogActive,
            'settings.nameFilterLogActive': data.settings.nameFilterLogActive,
            'settings.logChannelId': data.settings.logChannelId ?? null
          }
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

async function sendSystemLog(message, groupIdOrChannelId = null) {
  if (!groupIdOrChannelId) return;
  const key = groupIdOrChannelId.toString();

  // ถ้าค่าที่ส่งมาตรงกับ key ใน sectorCache → ใช้ logChannelId ของเซกเตอร์นั้น
  if (sectorCache[key]) {
    const sectorLogChannel = sectorCache[key]?.settings?.logChannelId;
    if (!sectorLogChannel) return; // เซกเตอร์ไม่ได้ตั้ง Log Channel → ไม่ส่ง
    bot.sendMessage(sectorLogChannel, message, { parse_mode: 'HTML' }).catch(() => {});
  } else {
    // ส่งตรงไปยัง channel ที่ระบุ (เช่น LOG_CHANNEL_ID สำหรับ global actions)
    bot.sendMessage(groupIdOrChannelId, message, { parse_mode: 'HTML' }).catch(() => {});
  }
}

// ==========================================
// 📺 ระบบ UI เมนูหน้าจอ
// ==========================================
function sendMainMenu(chatId) {
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);
  keyboard.push([
    { text: `🛰️ จัดการเซกเตอร์`, callback_data: `menu_sectors` },
    { text: `👥 จัดการ Whitelist`, callback_data: `menu_whitelist` }
  ]);
  keyboard.push([{ text: `👾 Boss Manager`, callback_data: `menu_boss` }]);
  keyboard.push([{ text: `❌ ปิดแผงควบคุม`, callback_data: `close_main_menu` }]);
  bot.sendMessage(chatId, '🛸 <b>แผงควบคุมหลัก (Alien Command)</b>\nโปรดเลือกพิกัดเซกเตอร์:', {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  });
}

function sendSectorsMenu(chatId) {
  const secText = TARGET_GROUPS.length > 0
    ? TARGET_GROUPS.map((g, i) => `${i + 1}. <code>${g.name}</code>\n    └ ID: <code>${g.id}</code>`).join('\n')
    : '<i>ไม่มีข้อมูลเซกเตอร์</i>';
  const submenu = [
    [
      { text: '➕ เพิ่มเซกเตอร์', callback_data: `opt_addsector_global` },
      { text: '➖ ลบเซกเตอร์', callback_data: `opt_delsector_global` }
    ],
    [{ text: '⬅️ กลับหน้าจอหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId, `🛰️ <b>ระบบจัดการเซกเตอร์เป้าหมาย</b>\n\n<b>รายชื่อเซกเตอร์ที่เชื่อมต่อ:</b>\n${secText}`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
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
  const notifyText = notifyUserIds.length > 0
    ? notifyUserIds.map(id => ` └ <code>${id}</code>`).join('\n')
    : ' └ ไม่มีข้อมูล ID';
  const submenu = [
    [
      { text: '➕ เพิ่ม Admin', callback_data: `opt_addwl_global` },
      { text: '➖ ลบ Admin', callback_data: `opt_delwl_global` }
    ],
    [
      { text: '🟢 แจ้งบอทออนไลน์', callback_data: 'notify_online' },
      { text: '🔧 แจ้งปิดปรับปรุง', callback_data: 'notify_maintenance' }
    ],
    [
      { text: '➕ เพิ่ม ID รับข้อความ', callback_data: 'opt_addnotify_global' },
      { text: '➖ ลบ ID รับข้อความ', callback_data: 'opt_delnotify_global' }
    ],
    [{ text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId,
    `👥 <b>ระบบจัดการผู้ควบคุม (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n${wlText}\n━━━━━━━━━━━━━━━━━━━━\n\n<b>📢 รายชื่อ ID ที่รอรับการแจ้งเตือน:</b>\n${notifyText}`, {
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
    [{ text: '📜 แจ้งเตือน Log (Log Config)', callback_data: `menu_log_${groupId}` }],
    [{ text: '⚙️ ตั้งค่า (Settings)', callback_data: `menu_set_${groupId}` }],
    [{ text: '⬅️ กลับหน้าจอหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId, `🛰️ <b>เซกเตอร์:</b> <code>${group.name}</code>\nเลือกระบบปฏิบัติการ:`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu }
  });
}

function sendLogMenu(chatId, groupId) {
  const group = TARGET_GROUPS.find(g => g.id == groupId);
  const config = sectorCache[groupId]?.settings;
  if (!config) return;
  const isStoryLogOn = config.storyBanLogActive || false;
  const isNameLogOn = config.nameFilterLogActive || false;
  const currentLogCh = config.logChannelId
    ? `<code>${config.logChannelId}</code>`
    : '❌ ไม่มี (ใช้แชนแนลกลางจาก .env)';
  const submenu = [
    [{ text: isStoryLogOn ? '👻 Log StoryBan: ON' : '👻 Log StoryBan: OFF', callback_data: `toggle_logstory_${groupId}` }],
    [{ text: isNameLogOn ? '🕵️ Log NameFilter: ON' : '🕵️ Log NameFilter: OFF', callback_data: `toggle_logname_${groupId}` }],
    [
      { text: '➕ ตั้งพิกัด Channel', callback_data: `opt_setlogch_${groupId}` },
      { text: '➖ ลบพิกัด Channel', callback_data: `opt_dellogch_${groupId}` }
    ],
    [{ text: '⬅️ ย้อนกลับ', callback_data: `select_group_${groupId}` }]
  ];
  bot.sendMessage(chatId,
    `📜 <b>ตั้งค่าระบบการส่งรายงาน Log ไปยัง Channel</b>\n🛰️ เซกเตอร์: <code>${group?.name}</code>\n📡 แชนแนลส่ง Log: ${currentLogCh}\n\nเลือกประเภท Log ที่ต้องการให้บอทส่งแจ้งเตือน:`, {
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
      { text: '💬 ตอบด้วยลิงก์ (Reply)', callback_data: `opt_replylink_${groupId}` }
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

// ==========================================
// 👾 Boss Panel Functions
// ==========================================

// เมนูหลัก Boss Panel
async function sendBossMainMenu(chatId) {
  const settings = await getSpawnSettings();
  const autoText = settings.autoSpawnActive ? '🟢 Auto Spawn: ON' : '🔴 Auto Spawn: OFF';
  const modeText = settings.spawnMode === 'time'
    ? `⏱️ ทุก ${settings.spawnIntervalMinutes} นาที`
    : `💬 ทุก ${settings.spawnEveryNMessages} ข้อความ`;

  const submenu = [
    [{ text: '📦 คลังบอส (จัดการ)', callback_data: 'boss_list' }],
    [{ text: '⚔️ เสกบอสทันที (Manual)', callback_data: 'boss_spawn_select' }],
    [{ text: autoText, callback_data: 'boss_toggle_auto' }],
    [{ text: `📊 โหมด: ${modeText}`, callback_data: 'boss_spawn_mode_menu' }],
    [{ text: '⬅️ กลับหน้าจอหลัก', callback_data: 'back_to_main' }]
  ];
  bot.sendMessage(chatId,
    `👾 <b>Boss Manager Panel</b>\n━━━━━━━━━━━━━━━━━━━━\n🤖 ระบบจัดการบอส RPG\n━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu } }
  );
}

// แสดงรายการบอสในคลัง
async function sendBossList(chatId) {
  const bosses = await getAllBosses();

  if (bosses.length === 0) {
    return bot.sendMessage(chatId,
      `📦 <b>คลังบอสว่างเปล่า</b>\nกด "➕ เพิ่มบอสใหม่" เพื่อเริ่มต้น`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '➕ เพิ่มบอสใหม่', callback_data: 'boss_create' }],
        [{ text: '⬅️ กลับ Boss Panel', callback_data: 'menu_boss' }]
      ]}}
    );
  }

  // สร้างปุ่มบอสแต่ละตัว
  const bossButtons = bosses.map(b => [{
    text: `${b.isActive ? '🟢' : '🔴'} ${b.name} (HP: ${b.hp.toLocaleString()})`,
    callback_data: `boss_detail_${b._id}`
  }]);
  bossButtons.push([{ text: '➕ เพิ่มบอสใหม่', callback_data: 'boss_create' }]);
  bossButtons.push([{ text: '⬅️ กลับ Boss Panel', callback_data: 'menu_boss' }]);

  bot.sendMessage(chatId,
    `📦 <b>คลังบอสทั้งหมด (${bosses.length} ตัว)</b>\n🟢 = เปิดใช้งาน | 🔴 = ปิดใช้งาน`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: bossButtons } }
  );
}

// แสดงรายละเอียดบอสตัวเดียว
async function sendBossDetail(chatId, bossId) {
  const boss = await getBossById(bossId);
  if (!boss) return bot.sendMessage(chatId, '❌ ไม่พบบอสนี้ในคลัง');

  const groupName = TARGET_GROUPS.find(g => g.id === boss.targetGroupId)?.name || `ID: ${boss.targetGroupId}`;
  const tagDurText = boss.tagDurationHours === 0 ? 'ถาวร' : `${boss.tagDurationHours} ชั่วโมง`;

  const submenu = [
    [
      { text: '✏️ แก้ชื่อ', callback_data: `boss_edit_${bossId}_name` },
      { text: '❤️ แก้ HP', callback_data: `boss_edit_${bossId}_hp` }
    ],
    [
      { text: '🖼️ แก้รูป URL', callback_data: `boss_edit_${bossId}_imageUrl` },
      { text: '🎯 แก้ % โอกาส', callback_data: `boss_edit_${bossId}_spawnRate` }
    ],
    [
      { text: '🏆 แก้ฉายารางวัล', callback_data: `boss_edit_${bossId}_rewardTag` },
      { text: '⏳ แก้อายุฉายา', callback_data: `boss_edit_${bossId}_tagDurationHours` }
    ],
    [{ text: boss.isActive ? '🔴 ปิดใช้งาน' : '🟢 เปิดใช้งาน', callback_data: `boss_toggle_active_${bossId}` }],
    [{ text: '🗑️ ลบบอสนี้', callback_data: `boss_delete_confirm_${bossId}` }],
    [{ text: '⬅️ กลับคลังบอส', callback_data: 'boss_list' }]
  ];

  bot.sendMessage(chatId,
    `👾 <b>รายละเอียดบอส</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `📛 ชื่อ: <b>${boss.name}</b>\n` +
    `❤️ HP: <b>${boss.hp.toLocaleString()}</b>\n` +
    `🛰️ กลุ่มเป้าหมาย: <b>${groupName}</b>\n` +
    `🎲 โอกาสเกิด: <b>${boss.spawnRate}%</b>\n` +
    `🏆 ฉายารางวัล: <b>${boss.rewardTag}</b>\n` +
    `⏳ อายุฉายา: <b>${tagDurText}</b>\n` +
    `🖼️ รูป: <code>${boss.imageUrl || 'ไม่มี'}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: submenu } }
  );
}

// เมนูเลือกบอสเพื่อ Manual Spawn (พร้อม Confirmation)
async function sendBossSpawnSelect(chatId) {
  const bosses = await getAllBosses();
  const activeBosses = bosses.filter(b => b.isActive);

  if (activeBosses.length === 0) {
    return bot.sendMessage(chatId, '❌ ไม่มีบอสที่เปิดใช้งานในคลัง กรุณาเพิ่มหรือเปิดบอสก่อน',
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: 'menu_boss' }]] } }
    );
  }

  const bossButtons = activeBosses.map(b => [{
    text: `⚔️ ${b.name}`,
    callback_data: `boss_spawn_confirm_${b._id}`
  }]);
  bossButtons.push([{ text: '❌ ยกเลิก', callback_data: 'menu_boss' }]);

  bot.sendMessage(chatId,
    `⚔️ <b>เลือกบอสที่จะเสก</b>\nกดเลือกบอส — จะมีหน้ายืนยันก่อนเสกจริง`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: bossButtons } }
  );
}

// หน้ายืนยันก่อน Manual Spawn
async function sendBossSpawnConfirm(chatId, bossId) {
  const boss = await getBossById(bossId);
  if (!boss) return;
  const groupName = TARGET_GROUPS.find(g => g.id === boss.targetGroupId)?.name || `ID: ${boss.targetGroupId}`;

  bot.sendMessage(chatId,
    `⚠️ <b>ยืนยันการเสกบอส</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `👾 บอส: <b>${boss.name}</b>\n` +
    `🛰️ กลุ่ม: <b>${groupName}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `ยืนยันเสกบอสตัวนี้เลยหรือไม่?`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [
        { text: '✅ ยืนยัน เสกเลย!', callback_data: `boss_spawn_do_${bossId}` },
        { text: '❌ ยกเลิก', callback_data: 'boss_spawn_select' }
      ]
    ]}}
  );
}

// เมนูตั้งค่า Spawn Mode
async function sendSpawnModeMenu(chatId) {
  const settings = await getSpawnSettings();
  bot.sendMessage(chatId,
    `⚙️ <b>ตั้งค่าโหมด Auto Spawn</b>\n\n` +
    `โหมดปัจจุบัน: <b>${settings.spawnMode === 'time' ? '⏱️ ตามเวลา' : '💬 นับข้อความ'}</b>\n` +
    `ทุก: <b>${settings.spawnMode === 'time' ? settings.spawnIntervalMinutes + ' นาที' : settings.spawnEveryNMessages + ' ข้อความ'}</b>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [
        { text: '⏱️ โหมดเวลา', callback_data: 'boss_set_mode_time' },
        { text: '💬 โหมดข้อความ', callback_data: 'boss_set_mode_message' }
      ],
      [
        { text: '➕ ตั้งค่าช่วงเวลา/จำนวน', callback_data: 'boss_set_interval' }
      ],
      [{ text: '⬅️ กลับ Boss Panel', callback_data: 'menu_boss' }]
    ]}}
  );
}

bot.onText(/\/start/, (msg) => {
  if (!globalWhitelist.includes(msg.from.id)) return;
  monitorSessions.delete(msg.from.id);
  sendMainMenu(msg.chat.id);
});

// คำสั่ง /boss — เปิด Boss Panel
bot.onText(/\/boss/, (msg) => {
  if (!globalWhitelist.includes(msg.from.id)) return;
  sendBossMainMenu(msg.chat.id);
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
  if (data === 'menu_sectors') return sendSectorsMenu(chatId);
  if (data === 'menu_whitelist') return sendWhitelistMenu(chatId);
  if (data === 'menu_boss') return sendBossMainMenu(chatId);
  if (data.startsWith('select_group_')) return sendGroupMenu(chatId, data.replace('select_group_', ''));
  if (data.startsWith('menu_sec_')) return sendSecurityMenu(chatId, data.replace('menu_sec_', ''));
  if (data.startsWith('menu_log_')) return sendLogMenu(chatId, data.replace('menu_log_', ''));
  if (data.startsWith('menu_namefilter_')) return sendNameFilterMenu(chatId, data.replace('menu_namefilter_', ''));
  if (data.startsWith('menu_comms_')) return sendCommsMenu(chatId, data.replace('menu_comms_', ''));
  if (data.startsWith('menu_set_')) return sendSettingsMenu(chatId, data.replace('menu_set_', ''));

  // ── Boss Panel Navigation ──
  if (data === 'boss_list') return sendBossList(chatId);
  if (data === 'boss_create') return startBossCreate(chatId, query.from.id);
  if (data === 'boss_spawn_select') return sendBossSpawnSelect(chatId);
  if (data === 'boss_spawn_mode_menu') return sendSpawnModeMenu(chatId);
  if (data.startsWith('boss_detail_')) return sendBossDetail(chatId, data.replace('boss_detail_', ''));
  if (data.startsWith('boss_spawn_confirm_')) return sendBossSpawnConfirm(chatId, data.replace('boss_spawn_confirm_', ''));

  // ── Boss: Toggle Auto Spawn ──
  if (data === 'boss_toggle_auto') {
    const settings = await getSpawnSettings();
    await saveSpawnSettings({ autoSpawnActive: !settings.autoSpawnActive });
    return sendBossMainMenu(chatId);
  }

  // ── Boss: Set Spawn Mode ──
  if (data === 'boss_set_mode_time') {
    await saveSpawnSettings({ spawnMode: 'time' });
    return sendSpawnModeMenu(chatId);
  }
  if (data === 'boss_set_mode_message') {
    await saveSpawnSettings({ spawnMode: 'message' });
    return sendSpawnModeMenu(chatId);
  }
  if (data === 'boss_set_interval') {
    bossEditSessions.set(query.from.id, { action: 'set_interval', chatId });
    return bot.sendMessage(chatId,
      `⚙️ <b>ตั้งค่าช่วงเวลา/จำนวน</b>\n\nพิมพ์ตัวเลข:\n• โหมดเวลา → จำนวนนาที (เช่น <code>30</code>)\n• โหมดข้อความ → จำนวนข้อความ (เช่น <code>50</code>)`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิก', callback_data: 'boss_spawn_mode_menu' }]] } }
    );
  }

  // ── Boss: Toggle Active ──
  if (data.startsWith('boss_toggle_active_')) {
    const bossId = data.replace('boss_toggle_active_', '');
    const boss = await getBossById(bossId);
    if (boss) await updateBoss(bossId, { isActive: !boss.isActive });
    return sendBossDetail(chatId, bossId);
  }

  // ── Boss: Delete Confirmation ──
  if (data.startsWith('boss_delete_confirm_')) {
    const bossId = data.replace('boss_delete_confirm_', '');
    const boss = await getBossById(bossId);
    if (!boss) return;
    return bot.sendMessage(chatId,
      `🗑️ <b>ยืนยันการลบบอส "${boss.name}"?</b>\nการกระทำนี้ไม่สามารถย้อนกลับได้`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [
          { text: '✅ ลบเลย', callback_data: `boss_delete_do_${bossId}` },
          { text: '❌ ยกเลิก', callback_data: `boss_detail_${bossId}` }
        ]
      ]}}
    );
  }
  if (data.startsWith('boss_delete_do_')) {
    const bossId = data.replace('boss_delete_do_', '');
    await deleteBoss(bossId);
    bot.sendMessage(chatId, `✅ <b>ลบบอสสำเร็จ</b>`, { parse_mode: 'HTML' });
    return sendBossList(chatId);
  }

  // ── Boss: Manual Spawn (ยืนยันแล้ว) ──
  if (data.startsWith('boss_spawn_do_')) {
    const bossId = data.replace('boss_spawn_do_', '');
    const boss = await getBossById(bossId);
    if (!boss) return bot.sendMessage(chatId, '❌ ไม่พบบอสนี้แล้ว');
    try {
      const sentMsg = await spawnBoss(bot, boss, tgQueue);
      // จำ messageId ไว้ลบปุ่มทีหลัง
      activeBossMessages.set(`${boss.targetGroupId}_${bossId}`, sentMsg.message_id);
      bot.sendMessage(chatId, `✅ <b>เสกบอส "${boss.name}" สำเร็จ!</b>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ Boss Panel', callback_data: 'menu_boss' }]] } }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ <b>เสกบอสล้มเหลว:</b> <code>${e.message}</code>`, { parse_mode: 'HTML' });
    }
    return;
  }

  // ── Boss: Attack (ผู้เล่นกดปุ่มโจมตีบอส) ──
  if (data.startsWith('boss_attack_')) {
    const bossId = data.replace('boss_attack_', '');
    const boss = await getBossById(bossId);
    if (!boss) {
      return bot.answerCallbackQuery(query.id, { text: '💨 บอสหนีไปแล้ว!', show_alert: true });
    }

    const attackerId = query.from.id;
    const attackerName = `${query.from.first_name || ''} ${query.from.last_name || ''}`.trim() || query.from.username || `ID:${attackerId}`;
    const attackerUsername = query.from.username || '';

    try {
      // บันทึกการล่า
      await recordKill(attackerId, boss.targetGroupId, boss.name, attackerUsername, attackerName);

      // แจกฉายา
      await awardTag(token, boss.targetGroupId, attackerId, attackerUsername, attackerName, boss.rewardTag, boss.tagDurationHours);

      // แก้ไขข้อความบอสให้แสดงว่าถูกล่าแล้ว (ลบปุ่มออก)
      const msgKey = `${boss.targetGroupId}_${bossId}`;
      const bossMessageId = activeBossMessages.get(msgKey);
      if (bossMessageId) {
        tgQueue.add(() =>
          bot.editMessageCaption(
            `⚔️ <b>[ บอสถูกล่าแล้ว! ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👾 <b>${boss.name}</b>\n💀 ถูกสังหารโดย: <a href="tg://user?id=${attackerId}">${attackerName}</a>\n🏆 ได้รับฉายา: <b>${boss.rewardTag}</b>\n━━━━━━━━━━━━━━━━━━━━`,
            { chat_id: boss.targetGroupId, message_id: bossMessageId, parse_mode: 'HTML' }
          )
        ).catch(() => {});
        activeBossMessages.delete(msgKey);
      }

      const durText = boss.tagDurationHours === 0 ? 'ถาวร' : `${boss.tagDurationHours} ชั่วโมง`;
      bot.answerCallbackQuery(query.id, {
        text: `🎉 คุณได้รับฉายา "${boss.rewardTag}" (${durText})!`,
        show_alert: true
      });

    } catch (e) {
      bot.answerCallbackQuery(query.id, {
        text: `⚠️ เกิดข้อผิดพลาด: ${e.message}`,
        show_alert: true
      });
    }
    return;
  }

  // ── Boss: Edit Field ──
  if (data.startsWith('boss_edit_')) {
    const parts = data.replace('boss_edit_', '').split('_');
    // format: boss_edit_{bossId}_{field} — field อาจมี _ ใน bossId (ObjectId ไม่มี แต่ป้องกันไว้)
    const field = parts[parts.length - 1];
    const bossId = parts.slice(0, -1).join('_');

    const fieldLabels = {
      name: 'ชื่อบอส',
      hp: 'HP (ตัวเลข)',
      imageUrl: 'URL รูปภาพ',
      spawnRate: '% โอกาสเกิด (0-100)',
      rewardTag: 'ฉายารางวัล',
      tagDurationHours: 'อายุฉายา (ชั่วโมง, 0=ถาวร)'
    };

    bossEditSessions.set(query.from.id, { action: 'edit_boss', bossId, field, chatId });
    return bot.sendMessage(chatId,
      `✏️ <b>แก้ไข: ${fieldLabels[field] || field}</b>\nพิมพ์ค่าใหม่:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิก', callback_data: `boss_detail_${bossId}` }]] } }
    );
  }

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
  if (data === 'notify_online') {
    if (notifyUserIds.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: '❌ ไม่มีรายชื่อ ID ในระบบ', show_alert: true });
    }
    notifyUserIds.forEach(targetId => {
      tgQueue.add(() => bot.sendMessage(targetId,
        `🟢 <b>บอทออนไลน์แล้ว!</b>\n\n🤖 ระบบกลับมาทำงานตามปกติแล้ว\n✅ พร้อมให้บริการเต็มรูปแบบ`,
        { parse_mode: 'HTML' }
      )).catch(() => {});
    });
    bot.answerCallbackQuery(query.id, { text: `🟢 กำลังทยอยส่ง 'บอทออนไลน์' ไปยัง ${notifyUserIds.length} ID...`, show_alert: false });
    return;
  }
  if (data === 'notify_maintenance') {
    if (notifyUserIds.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: '❌ ไม่มีรายชื่อ ID ในระบบ', show_alert: true });
    }
    notifyUserIds.forEach(targetId => {
      tgQueue.add(() => bot.sendMessage(targetId,
        `🔧 <b>ปิดปรับปรุงบอทชั่วคราว</b>\n\n⚙️ ระบบกำลังอยู่ในช่วงปรับปรุง\n⏳ กรุณารอสักครู่ แล้วกลับมาใหม่อีกครั้ง`,
        { parse_mode: 'HTML' }
      )).catch(() => {});
    });
    bot.answerCallbackQuery(query.id, { text: `🔧 กำลังทยอยส่ง 'ปิดปรับปรุง' ไปยัง ${notifyUserIds.length} ID...`, show_alert: false });
    return;
  }
  if (data.startsWith('toggle_logstory_')) {
    const groupId = data.replace('toggle_logstory_', '');
    sectorCache[groupId].settings.storyBanLogActive = !sectorCache[groupId].settings.storyBanLogActive;
    await saveSectorData(groupId);
    return sendLogMenu(chatId, groupId);
  }
  if (data.startsWith('toggle_logname_')) {
    const groupId = data.replace('toggle_logname_', '');
    sectorCache[groupId].settings.nameFilterLogActive = !sectorCache[groupId].settings.nameFilterLogActive;
    await saveSectorData(groupId);
    return sendLogMenu(chatId, groupId);
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

    // Global actions: opt_addwl_global, opt_delwl_global, opt_addsector_global, opt_delsector_global
    if (data.includes('_global')) {
      action = data.replace('opt_', '').replace('_global', '');
      groupId = 'global';
    } else {
      const parts = data.split('_');
      action = parts[1];
      groupId = parts[2];
    }

    // กำหนด back callback ตามประเภท action
    let backTarget = `select_group_${groupId}`;
    if (action.includes('wl')) backTarget = 'menu_whitelist';
    if (action.includes('sector')) backTarget = 'menu_sectors';
    if (action.includes('logch')) backTarget = `menu_log_${groupId}`;
    if (action.includes('notify')) backTarget = 'menu_whitelist';

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
    if (action === 'addwl')      promptMsg = `➕ <b>[เพิ่ม Admin]</b>\nพิมพ์ <b>ID ตัวเลข</b> ของผู้ที่ต้องการตั้งเป็น Admin:`;
    if (action === 'delwl')      promptMsg = `➖ <b>[ลบ Admin]</b>\nพิมพ์ <b>ID ตัวเลข</b> ของผู้ที่ต้องการปลดจาก Admin:`;
    if (action === 'addnotify')  promptMsg = `➕ <b>[เพิ่ม ID รับข้อความแจ้งเตือน]</b>\nพิมพ์ <b>Telegram ID</b> ของบุคคล หรือ <b>ID กลุ่ม</b>\n(กลุ่มจะขึ้นต้นด้วย <code>-100</code> เช่น <code>-100123456789</code>):`;
    if (action === 'delnotify')  promptMsg = `➖ <b>[ลบ ID รับข้อความแจ้งเตือน]</b>\nพิมพ์ <b>Telegram ID หรือ ID กลุ่ม</b> ที่ต้องการลบออกจากระบบ:`;
    if (action === 'addsector') promptMsg = `➕ <b>[เพิ่มเซกเตอร์]</b>\nพิมพ์ <b>ข้อมูลเซกเตอร์</b> (รูปแบบ: <code>IDกลุ่ม:ชื่อกลุ่ม</code>)\nตัวอย่าง: <code>-10012345678:ดาวอังคาร</code>`;
    if (action === 'delsector') promptMsg = `➖ <b>[ลบเซกเตอร์]</b>\nพิมพ์ <b>ID ตัวเลข</b> ของเซกเตอร์ที่ต้องการลบ\n(เช่น: <code>-10012345678</code>):`;
    if (action === 'setlogch')  promptMsg = `➕ <b>[ตั้งพิกัด Log Channel]</b>\nพิมพ์ <b>ID ตัวเลข</b> ของ Telegram Channel ที่ต้องการรับ Log ของกลุ่มนี้\n(ตัวอย่าง: <code>-100123456789</code>):`;
    if (action === 'dellogch')  promptMsg = `➖ <b>[ลบพิกัด Log Channel]</b>\nพิมพ์คำว่า <code>ยืนยัน</code> เพื่อลบพิกัด Channel เฉพาะของเซกเตอร์นี้\n(บอทจะกลับไปใช้แชนแนลกลางจาก .env แทน):`;

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

  const isTargetGroup = TARGET_GROUPS.some(g => Number(g.id) === msg.chat.id);
  const currentSector = sectorCache[msg.chat.id.toString()];
  const groupInfo = TARGET_GROUPS.find(g => Number(g.id) === msg.chat.id);

  // 🛡️ [AUTO DEFENSE] ทำงานเฉพาะในกลุ่มเป้าหมาย ไม่ใช่ Whitelist
  if (isTargetGroup && currentSector && !globalWhitelist.includes(msg.from.id)) {

    // นับข้อความสำหรับ Message-based Auto Spawn
    incrementMessageCounter(bot, tgQueue).catch(() => {});

    // 1. STORY BAN
    if (currentSector.settings.storyBanActive &&
        (msg.forward_from_chat || msg.forward_from || msg.story || msg.forward_date)) {
      tgQueue.add(() => bot.deleteMessage(msg.chat.id, msg.message_id)).catch(() => {});
      tgQueue.add(() => bot.banChatMember(msg.chat.id, msg.from.id)).catch(() => {});
      if (currentSector.settings.storyBanLogActive) {
        await sendSystemLog(
          `👻 <b>[STORYBAN TRIGGERED]</b>\nเป้าหมาย: <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>)\nเซกเตอร์: <code>${groupInfo?.name || msg.chat.title || msg.chat.id}</code>\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`,
          msg.chat.id
        );
      }
      return;
    }

    // 2. NAME FILTER BAN
    if (currentSector.settings.nameFilterActive && currentSector.impersonatorNames.length > 0) {
      const senderName = fullName.toLowerCase();
      const isMijji = currentSector.impersonatorNames.some(bName => senderName.includes(bName.toLowerCase()));
      if (isMijji) {
        tgQueue.add(() => bot.deleteMessage(msg.chat.id, msg.message_id)).catch(() => {});
        tgQueue.add(() => bot.banChatMember(msg.chat.id, msg.from.id)).catch(() => {});
        if (currentSector.settings.nameFilterLogActive) {
          await sendSystemLog(
            `🚫 <b>[NAME FILTER BAN]</b>\nเป้าหมาย: <code>${fullName}</code> (🆔 <code>${msg.from.id}</code>)\nเซกเตอร์: <code>${groupInfo?.name || msg.chat.title || msg.chat.id}</code>\n📅 เวลา (ไทย): <code>${getThailandTimestamp()}</code>`,
            msg.chat.id
          );
        }
        return;
      }
    }
  }

  // 📺 [TV MODE] รับคำสั่งจาก Admin เท่านั้น
  if (!globalWhitelist.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  const session = monitorSessions.get(msg.from.id);
  if (!session) {
    // ── ตรวจ Boss Edit Session ──
    const bossSession = bossEditSessions.get(msg.from.id);
    if (bossSession && msg.text) {
      bossEditSessions.delete(msg.from.id);
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

      const { action, chatId: bChatId, bossId, field } = bossSession;

      if (action === 'edit_boss') {
        // แปลงค่าตามประเภท field
        let value = msg.text.trim();
        if (['hp', 'spawnRate', 'tagDurationHours'].includes(field)) {
          value = parseInt(value);
          if (isNaN(value)) {
            return bot.sendMessage(bChatId, `❌ ต้องเป็นตัวเลขเท่านั้น`);
          }
          // ตรวจ range
          if (field === 'spawnRate') value = Math.min(100, Math.max(0, value));
          if (field === 'tagDurationHours') value = Math.max(0, value);
          if (field === 'hp') value = Math.max(1, value);
        }
        await updateBoss(bossId, { [field]: value });
        bot.sendMessage(bChatId, `✅ <b>อัปเดตสำเร็จ!</b>`, { parse_mode: 'HTML' });
        return sendBossDetail(bChatId, bossId);
      }

      if (action === 'set_interval') {
        const num = parseInt(msg.text.trim());
        if (isNaN(num) || num < 1) {
          return bot.sendMessage(bChatId, `❌ ต้องเป็นตัวเลขมากกว่า 0`);
        }
        const settings = await getSpawnSettings();
        if (settings.spawnMode === 'time') {
          await saveSpawnSettings({ spawnIntervalMinutes: num });
          bot.sendMessage(bChatId, `✅ <b>ตั้งค่า Auto Spawn ทุก ${num} นาที</b>`, { parse_mode: 'HTML' });
        } else {
          await saveSpawnSettings({ spawnEveryNMessages: num });
          bot.sendMessage(bChatId, `✅ <b>ตั้งค่า Auto Spawn ทุก ${num} ข้อความ</b>`, { parse_mode: 'HTML' });
        }
        return sendSpawnModeMenu(bChatId);
      }

      if (action === 'create_boss') {
        // รับ input ทีละ field ผ่าน multi-step
        return handleBossCreateInput(bChatId, msg.from.id, bossSession, msg.text.trim());
      }
    }
    return;
  }

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
  const finishMenuSectors = { inline_keyboard: [[{ text: '⬅️ กลับสู่จัดการเซกเตอร์', callback_data: `menu_sectors` }]] };

  let targetInput, reason, spaceIdx, resolved, targetUserId, targetName;

  switch (action) {

    // ── Sector Management ──
    case 'addsector': {
      const parts = inputStr.split(':');
      if (parts.length < 2) {
        bot.sendMessage(chatId, `❌ รูปแบบไม่ถูกต้อง ต้องใช้ ID:ชื่อกลุ่ม`, { parse_mode: 'HTML', reply_markup: finishMenuSectors });
        break;
      }
      const sectorId = parseInt(parts[0].trim());
      const sectorName = parts.slice(1).join(':').trim();
      if (isNaN(sectorId)) {
        bot.sendMessage(chatId, `❌ ID กลุ่มต้องเป็นตัวเลข`, { parse_mode: 'HTML', reply_markup: finishMenuSectors });
        break;
      }
      if (TARGET_GROUPS.some(g => g.id === sectorId)) {
        bot.sendMessage(chatId, `❌ มีเซกเตอร์ ID นี้อยู่ในระบบแล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuSectors });
        break;
      }
      TARGET_GROUPS.push({ id: sectorId, name: sectorName });
      await saveGlobalConfig();
      let config = await SectorConfig.findOne({ groupId: sectorId.toString() });
      if (!config) {
        config = await SectorConfig.create({ groupId: sectorId.toString(), impersonatorNames: [], settings: {} });
      }
      sectorCache[sectorId.toString()] = config;
      bot.sendMessage(chatId, `✅ เพิ่มเซกเตอร์ <b>${sectorName}</b> สำเร็จ!`, { parse_mode: 'HTML', reply_markup: finishMenuSectors });
      await sendSystemLog(`🛰️ <b>[ADD SECTOR]</b>\nเซกเตอร์: ${sectorName} (ID: <code>${sectorId}</code>)\nโดย: ${fullName} (<code>${msg.from.id}</code>)\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, LOG_CHANNEL_ID);
      break;
    }

    case 'delsector': {
      const sectorId = parseInt(inputStr);
      if (isNaN(sectorId)) {
        bot.sendMessage(chatId, `❌ ID กลุ่มต้องเป็นตัวเลข`, { parse_mode: 'HTML', reply_markup: finishMenuSectors });
        break;
      }
      TARGET_GROUPS = TARGET_GROUPS.filter(g => g.id !== sectorId);
      await saveGlobalConfig();
      bot.sendMessage(chatId, `✅ ลบเซกเตอร์ ID <code>${sectorId}</code> เรียบร้อยแล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuSectors });
      await sendSystemLog(`🛰️ <b>[DELETE SECTOR]</b>\nลบ ID: <code>${sectorId}</code>\nโดย: ${fullName} (<code>${msg.from.id}</code>)\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, LOG_CHANNEL_ID);
      break;
    }

    // ── Log Channel Management ──
    case 'setlogch': {
      if (!inputStr.startsWith('-100')) {
        bot.sendMessage(chatId, `❌ รูปแบบ ID ไม่ถูกต้อง (แชนแนล Telegram มักขึ้นต้นด้วย -100)`, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `menu_log_${groupId}` }]] }
        });
        break;
      }
      const setlogKey = groupId.toString();
      console.log(`[setlogch] groupId="${setlogKey}", inputStr="${inputStr}"`);
      console.log(`[setlogch] sectorCache keys:`, Object.keys(sectorCache));
      if (!sectorCache[setlogKey]) {
        bot.sendMessage(chatId, `❌ ไม่พบข้อมูลเซกเตอร์ key="${setlogKey}" ในระบบ`, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `menu_log_${groupId}` }]] }
        });
        break;
      }
      sectorCache[setlogKey].settings.logChannelId = inputStr;
      await saveSectorData(setlogKey);
      bot.sendMessage(chatId, `✅ ตั้งแชนแนลส่ง Log ไปที่ <code>${inputStr}</code> สำเร็จ!`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `menu_log_${groupId}` }]] }
      });
      break;
    }

    case 'dellogch': {
      if (inputStr !== 'ยืนยัน') {
        bot.sendMessage(chatId, `❌ คุณพิมพ์คำยืนยันไม่ถูกต้อง ระบบยกเลิกคำสั่ง`, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `menu_log_${groupId}` }]] }
        });
        break;
      }
      sectorCache[groupId].settings.logChannelId = null;
      await saveSectorData(groupId);
      bot.sendMessage(chatId, `✅ ลบพิกัด Channel เฉพาะกลุ่มแล้ว ระบบจะสลับไปใช้แชนแนลกลางอัตโนมัติ`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ กลับ', callback_data: `menu_log_${groupId}` }]] }
      });
      break;
    }

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
      await sendSystemLog(`👥 <b>[WHITELIST ADD]</b>\nเพิ่ม ID: <code>${newId}</code>\nโดย: ${fullName} (<code>${msg.from.id}</code>)\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, LOG_CHANNEL_ID);
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
      await sendSystemLog(`👥 <b>[WHITELIST REMOVE]</b>\nลบ ID: <code>${delId}</code>\nโดย: ${fullName} (<code>${msg.from.id}</code>)\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, LOG_CHANNEL_ID);
      break;
    }

    // ── Notify User Management ──
    case 'addnotify': {
      const targetId = parseInt(inputStr);
      if (isNaN(targetId)) {
        bot.sendMessage(chatId, `❌ ID ต้องเป็นตัวเลขเท่านั้น (ตัวอย่างกลุ่ม: <code>-100123456789</code>)`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
        break;
      }
      if (notifyUserIds.includes(targetId)) {
        bot.sendMessage(chatId, `❌ มี ID <code>${targetId}</code> ในรายการแจ้งเตือนอยู่แล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
        break;
      }
      notifyUserIds.push(targetId);
      await saveGlobalConfig();
      const isGroup = targetId < 0;
      bot.sendMessage(chatId, `✅ เพิ่ม${isGroup ? 'กลุ่ม' : 'ผู้ใช้'} ID <code>${targetId}</code> เข้าสู่ระบบแจ้งสถานะแล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
      break;
    }

    case 'delnotify': {
      const targetId = parseInt(inputStr);
      if (isNaN(targetId)) {
        bot.sendMessage(chatId, `❌ ID ต้องเป็นตัวเลขเท่านั้น (ตัวอย่างกลุ่ม: <code>-100123456789</code>)`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
        break;
      }
      if (!notifyUserIds.includes(targetId)) {
        bot.sendMessage(chatId, `❌ ไม่พบ ID <code>${targetId}</code> ในรายการแจ้งเตือน`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
        break;
      }
      notifyUserIds = notifyUserIds.filter(id => id !== targetId);
      await saveGlobalConfig();
      bot.sendMessage(chatId, `✅ ลบ ID <code>${targetId}</code> ออกจากระบบแจ้งสถานะแล้ว`, { parse_mode: 'HTML', reply_markup: finishMenuWL });
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

          await sendSystemLog(`📜 <b>[ AUTO-BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nสาเหตุ: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, groupId);
          bot.sendMessage(chatId, `☢️ <b>Warn ครบเกณฑ์ — AUTO-BAN สำเร็จ!</b>`, { parse_mode: 'HTML', reply_markup: finishMenu });
        } else {
          const rem = WARN_LIMIT - currentWarn;
          const m = await bot.sendMessage(targetGroupId,
            `☢️ <b>[ BIOHAZARD WARNING ]</b>\n👤 <a href="tg://user?id=${targetUserId}">${targetName}</a>\n☢️ รังสีสะสม: [${warnBar}] ${currentWarn}/${WARN_LIMIT}\n⚠️ เหตุผล: <code>${reason}</code>\n🚨 อีก <b>${rem} ครั้ง</b> จะถูก AUTO-BAN`,
            { parse_mode: 'HTML' }
          );
          if (delTime > 0) setTimeout(() => { bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}); }, delTime);

          await sendSystemLog(`📜 <b>[ WARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ${currentWarn}/${WARN_LIMIT}\nสาเหตุ: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, groupId);
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

        await sendSystemLog(`📜 <b>[ UNWARN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>) | ${oldWarn} → ${currentWarn}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, groupId);
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

        await sendSystemLog(`📜 <b>[ BAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nข้อหา: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, groupId);
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

        await sendSystemLog(`📜 <b>[ UNBAN LOG ]</b>\nเซกเตอร์: ${groupName}\nเป้าหมาย: ${targetName} (🆔 <code>${targetUserId}</code>)\nหมายเหตุ: ${reason}\n📅 เวลา: <code>${getThailandTimestamp()}</code>`, groupId);
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

// ==========================================
// 👾 Boss Create — Multi-step form
// ==========================================
const bossCreateSteps = ['name', 'hp', 'imageUrl', 'targetGroupId', 'spawnRate', 'rewardTag', 'tagDurationHours'];
const bossCreateLabels = {
  name: '📛 ชื่อบอส',
  hp: '❤️ HP (ตัวเลข เช่น 10000)',
  imageUrl: '🖼️ URL รูปภาพ (หรือพิมพ์ - เพื่อข้าม)',
  targetGroupId: `🛰️ เลือกกลุ่มเป้าหมาย (พิมพ์ ID หรือชื่อ):\n${TARGET_GROUPS.map((g, i) => `${i + 1}. ${g.name} → <code>${g.id}</code>`).join('\n')}`,
  spawnRate: '🎲 % โอกาสเกิด (0-100)',
  rewardTag: '🏆 ฉายารางวัลสำหรับผู้ที่ล่า',
  tagDurationHours: '⏳ อายุฉายา (ชั่วโมง, พิมพ์ 0 = ถาวร)'
};

function startBossCreate(chatId, userId) {
  bossEditSessions.set(userId, {
    action: 'create_boss',
    chatId,
    step: 0,
    data: {}
  });
  bot.sendMessage(chatId,
    `➕ <b>สร้างบอสใหม่</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${bossCreateLabels['name']}:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิก', callback_data: 'boss_list' }]] } }
  );
}

async function handleBossCreateInput(chatId, userId, session, input) {
  const step = session.step;
  const field = bossCreateSteps[step];

  // แปลงค่าตามประเภท
  let value = input;
  if (field === 'hp' || field === 'spawnRate' || field === 'tagDurationHours') {
    value = parseInt(input);
    if (isNaN(value)) {
      bossEditSessions.set(userId, session); // คืน session
      return bot.sendMessage(chatId, `❌ ต้องเป็นตัวเลข ลองอีกครั้ง:`);
    }
  }
  if (field === 'targetGroupId') {
    value = parseInt(input);
    if (isNaN(value)) {
      // ลองหาจากชื่อ
      const found = TARGET_GROUPS.find(g => g.name.toLowerCase().includes(input.toLowerCase()));
      if (!found) {
        bossEditSessions.set(userId, session);
        return bot.sendMessage(chatId, `❌ ไม่พบกลุ่มนี้ ลองใหม่:`);
      }
      value = found.id;
    }
  }
  if (field === 'imageUrl' && input === '-') value = null;

  session.data[field] = value;
  const nextStep = step + 1;

  if (nextStep >= bossCreateSteps.length) {
    // ครบทุก field → สร้างบอส
    try {
      const boss = await createBoss(session.data);
      bot.sendMessage(chatId,
        `✅ <b>สร้างบอส "${boss.name}" สำเร็จ!</b>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📦 ดูคลังบอส', callback_data: 'boss_list' }]] } }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ สร้างบอสล้มเหลว: ${e.message}`);
    }
  } else {
    // ไปขั้นตอนถัดไป
    session.step = nextStep;
    bossEditSessions.set(userId, session);
    const nextField = bossCreateSteps[nextStep];
    bot.sendMessage(chatId,
      `${bossCreateLabels[nextField]}:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ ยกเลิก', callback_data: 'boss_list' }]] } }
    );
  }
}

// ==========================================
// ⏰ Cron Jobs — รันทุก 1 นาที
// ==========================================
setInterval(async () => {
  // 1. ตรวจ Tag หมดอายุ → ลบอัตโนมัติ
  await checkExpiredTags(token);

  // 2. ตรวจ Auto Spawn แบบ time-based
  await checkAutoSpawn(bot, tgQueue);
}, 60 * 1000); // ทุก 60 วินาที

console.log('⏰ Cron Jobs เริ่มทำงาน: Tag Expiry + Auto Spawn (ทุก 1 นาที)');

// 🌐 Web Server ป้องกัน Render Sleep
http.createServer((req, res) => res.end('ALIEN_STATION_ONLINE')).listen(process.env.PORT || 3000);
