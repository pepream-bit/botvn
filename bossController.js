// ==========================================
// 👾 bossController.js — ระบบจัดการบอส RPG
// ==========================================

const mongoose = require('mongoose');

// ── Schema: คลังบอสแต่ละตัว ──
const BossSchema = new mongoose.Schema({
  name:          { type: String, required: true },       // ชื่อบอส
  hp:            { type: Number, default: 10000 },       // พลังชีวิต (แสดงใน UI)
  imageUrl:      { type: String, default: null },        // URL รูปบอส
  targetGroupId: { type: Number, required: true },       // กลุ่มที่บอสจะเกิด
  spawnRate:     { type: Number, default: 50 },          // เปอร์เซ็นต์โอกาสสุ่มเกิด (0-100)
  rewardTag:     { type: String, default: '👑 นักล่าบอส' }, // ฉายาที่ได้เมื่อฆ่า
  tagDurationHours: { type: Number, default: 24 },       // อายุฉายา (ชั่วโมง, 0 = ถาวร)
  isActive:      { type: Boolean, default: true },       // เปิด/ปิดใช้งานในระบบสุ่ม
  maxDmgPct:    { type: Number, default: 5 },           // % HP สูงสุดต่อการตี 1 ครั้ง (ต่อคน)
  rank:         { type: String, default: 'normal', enum: ['normal','rare','legend','mystic','limit'] },
}, { timestamps: true });

const Boss = mongoose.model('Boss', BossSchema);

// ── ตารางระดับบอส ──
const BOSS_RANK = {
  normal:  { emoji: '⚪', label: 'Normal',  border: '─' },
  rare:    { emoji: '🔵', label: 'Rare',    border: '═' },
  legend:  { emoji: '🟡', label: 'Legend',  border: '━' },
  mystic:  { emoji: '🟣', label: 'Mystic',  border: '▰' },
  limit:   { emoji: '🔴', label: 'LIMIT',   border: '█' },
};
function getRank(rank) { return BOSS_RANK[rank] || BOSS_RANK.normal; }

// ── Schema: การตั้งค่าระบบ Spawn ──
const SpawnSettingsSchema = new mongoose.Schema({
  configId:    { type: String, default: 'spawn_main' },
  autoSpawnActive:    { type: Boolean, default: false },  // เปิด/ปิด Auto Spawn
  spawnMode:   { type: String, default: 'time' },         // 'time' = ตามเวลา, 'message' = นับข้อความ
  spawnIntervalMinutes: { type: Number, default: 60 },    // ถ้า mode=time: เกิดทุกกี่นาที
  spawnEveryNMessages:  { type: Number, default: 100 },   // ถ้า mode=message: เกิดทุกกี่ข้อความ
  messageCounter: { type: Number, default: 0 },           // นับข้อความปัจจุบัน
  lastSpawnAt:  { type: Date, default: null },             // เวลาที่ Spawn ล่าสุด
});

const SpawnSettings = mongoose.model('SpawnSettings', SpawnSettingsSchema);

// ──────────────────────────────────────────
// 📌 Boss CRUD Functions
// ──────────────────────────────────────────

// สร้างบอสใหม่ในคลัง
async function createBoss(data) {
  const boss = await Boss.create(data);
  console.log(`✅ [Boss] สร้างบอส "${boss.name}" สำเร็จ`);
  return boss;
}

// ดูบอสทั้งหมด
async function getAllBosses() {
  return await Boss.find().sort({ createdAt: -1 });
}

// ดูบอสตัวเดียวด้วย ID
async function getBossById(bossId) {
  return await Boss.findById(bossId);
}

// แก้ไขข้อมูลบอส
async function updateBoss(bossId, data) {
  return await Boss.findByIdAndUpdate(bossId, { $set: data }, { new: true });
}

// ลบบอสออกจากคลัง
async function deleteBoss(bossId) {
  return await Boss.findByIdAndDelete(bossId);
}

// ──────────────────────────────────────────
// 📌 Spawn Logic
// ──────────────────────────────────────────

// โหลด (หรือสร้าง) SpawnSettings
async function getSpawnSettings() {
  let settings = await SpawnSettings.findOne({ configId: 'spawn_main' });
  if (!settings) {
    settings = await SpawnSettings.create({ configId: 'spawn_main' });
  }
  return settings;
}

// บันทึก SpawnSettings
async function saveSpawnSettings(data) {
  return await SpawnSettings.findOneAndUpdate(
    { configId: 'spawn_main' },
    { $set: data },
    { upsert: true, new: true }
  );
}

// สุ่มเลือกบอสจากคลัง โดยคำนึง spawnRate
async function pickRandomBoss() {
  const bosses = await Boss.find({ isActive: true });
  if (bosses.length === 0) return null;

  // กรองตาม spawnRate — สุ่มทีละตัว
  const candidates = bosses.filter(b => Math.random() * 100 <= b.spawnRate);
  if (candidates.length === 0) return null;

  // สุ่มหยิบ 1 ตัวจากที่ผ่านการกรอง
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ฟังก์ชันกลาง: เสกบอสลงกลุ่ม (ทั้ง Manual และ Auto ใช้ฟังก์ชันนี้)
async function spawnBoss(bot, boss, tgQueue) {
  const chatId = boss.targetGroupId;

  try {
    // ถ้ามีรูป → ส่งรูปพร้อม caption
    // ถ้าไม่มีรูป → ส่งเป็นข้อความเท่านั้น
    const hpBar = '🟥'.repeat(10);
    const r = getRank(boss.rank);
    const line = r.border.repeat(20);
    const caption =
      `${r.emoji} <b>[ ${r.label} BOSS ปรากฏตัว! ]</b>\n` +
      `${line}\n` +
      `👾 <b>${boss.name}</b>\n` +
      `❤️ <b>${boss.hp.toLocaleString()}</b> / ${boss.hp.toLocaleString()} HP  (-0%)\n` +
      `${hpBar}\n` +
      `🏆 รางวัล: <b>${boss.rewardTag}</b>\n` +
      `${line}\n` +
      `⚡️ กดเพื่อโจมตี! (ตีได้สูงสุด ${boss.maxDmgPct || 5}%/ครั้ง)`;

    // สร้างปุ่ม "ล่าบอส" inline
    const keyboard = {
      inline_keyboard: [[
        { text: `⚔️ โจมตี ${boss.name}!`, callback_data: `boss_attack_${boss._id}` }
      ]]
    };

    let sentMsg;
    if (boss.imageUrl && boss.imageUrl.startsWith('fileid:')) {
      // รูปแบบ: fileid:type:file_id
      const [, mediaType, fileId] = boss.imageUrl.split(':');
      if (mediaType === 'animation') {
        sentMsg = await tgQueue.add(() =>
          bot.sendAnimation(chatId, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard })
        );
      } else if (mediaType === 'video') {
        sentMsg = await tgQueue.add(() =>
          bot.sendVideo(chatId, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard })
        );
      } else {
        // photo (default)
        sentMsg = await tgQueue.add(() =>
          bot.sendPhoto(chatId, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard })
        );
      }
    } else if (boss.imageUrl) {
      // URL ธรรมดา (เดิม)
      sentMsg = await tgQueue.add(() =>
        bot.sendPhoto(chatId, boss.imageUrl, { caption, parse_mode: 'HTML', reply_markup: keyboard })
      );
    } else {
      sentMsg = await tgQueue.add(() =>
        bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: keyboard })
      );
    }

    // อัปเดตเวลา spawn ล่าสุด
    await saveSpawnSettings({ lastSpawnAt: new Date() });

    console.log(`👾 [Boss] Spawn "${boss.name}" ลงกลุ่ม ${chatId} (msg_id: ${sentMsg.message_id})`);
    return sentMsg;

  } catch (e) {
    console.error(`❌ [Boss] Spawn ล้มเหลว: ${e.message}`);
    throw e;
  }
}

// ──────────────────────────────────────────
// 📌 Auto Spawn: เช็คและ Trigger อัตโนมัติ
// เรียกจาก index.js ทุก 1 นาที (time mode)
// หรือทุกครั้งที่มีข้อความในกลุ่ม (message mode)
// ──────────────────────────────────────────
async function checkAutoSpawn(bot, tgQueue) {
  try {
    const settings = await getSpawnSettings();
    if (!settings.autoSpawnActive) return; // ระบบปิดอยู่ → ข้าม

    let shouldSpawn = false;

    if (settings.spawnMode === 'time') {
      // ตรวจว่าครบเวลาหรือยัง
      const now = new Date();
      const lastSpawn = settings.lastSpawnAt ? new Date(settings.lastSpawnAt) : new Date(0);
      const elapsedMinutes = (now - lastSpawn) / 1000 / 60;
      if (elapsedMinutes >= settings.spawnIntervalMinutes) {
        shouldSpawn = true;
      }
    }
    // message mode จะถูก trigger จาก index.js แทน (ดูด้านล่าง)

    if (shouldSpawn) {
      const boss = await pickRandomBoss();
      if (boss) {
        await spawnBoss(bot, boss, tgQueue);
        console.log(`⏰ [AutoSpawn] Time-based spawn: ${boss.name}`);
      }
    }
  } catch (e) {
    console.error('❌ [AutoSpawn] checkAutoSpawn ล้มเหลว:', e.message);
  }
}

// เพิ่ม message counter (เรียกทุกครั้งที่มีข้อความในกลุ่มเป้าหมาย)
async function incrementMessageCounter(bot, tgQueue) {
  try {
    const settings = await getSpawnSettings();
    if (!settings.autoSpawnActive || settings.spawnMode !== 'message') return;

    const newCount = (settings.messageCounter || 0) + 1;

    if (newCount >= settings.spawnEveryNMessages) {
      // ครบจำนวนข้อความ → สุ่ม Spawn
      await saveSpawnSettings({ messageCounter: 0 });
      const boss = await pickRandomBoss();
      if (boss) {
        await spawnBoss(bot, boss, tgQueue);
        console.log(`💬 [AutoSpawn] Message-based spawn: ${boss.name} (ทุก ${settings.spawnEveryNMessages} ข้อความ)`);
      }
    } else {
      // ยังไม่ครบ → แค่อัปเดต counter
      await saveSpawnSettings({ messageCounter: newCount });
    }
  } catch (e) {
    console.error('❌ [AutoSpawn] incrementMessageCounter ล้มเหลว:', e.message);
  }
}

module.exports = {
  BOSS_RANK,
  getRank,
  Boss,
  SpawnSettings,
  createBoss,
  getAllBosses,
  getBossById,
  updateBoss,
  deleteBoss,
  getSpawnSettings,
  saveSpawnSettings,
  pickRandomBoss,
  spawnBoss,
  checkAutoSpawn,
  incrementMessageCounter
};
