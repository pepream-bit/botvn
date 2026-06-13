// ==========================================
// 🏷️ tagController.js — ระบบจัดการฉายา (Tag)
// flow: promoteChatMember (admin) → setChatAdministratorCustomTitle
//       ฉายาอยู่ตลอดจนกว่าจะหมดอายุ → removeChatMemberTag จึง demote
// ==========================================

const mongoose = require('mongoose');

// ── Schema: เก็บข้อมูลผู้เล่นและฉายาที่ถืออยู่ ──
const PlayerSchema = new mongoose.Schema({
  userId:    { type: Number, required: true },
  groupId:   { type: String, required: true },
  username:  { type: String, default: '' },
  fullName:  { type: String, default: '' },
  currentTag:     { type: String, default: null },
  tagExpiresAt:   { type: Date,   default: null },
  killCount:      { type: Number, default: 0 },
  killHistory: [{
    bossName:  String,
    killedAt:  { type: Date, default: Date.now }
  }]
}, { timestamps: true });

PlayerSchema.index({ userId: 1, groupId: 1 }, { unique: true });
const Player = mongoose.model('Player', PlayerSchema);

// ──────────────────────────────────────────
// helper: sleep
// ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ──────────────────────────────────────────
// 📌 promote เป็น admin (can_manage_chat: true เท่านั้น)
// ──────────────────────────────────────────
async function promoteToAdmin(botToken, chatId, userId) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/promoteChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:                chatId,
      user_id:                userId,
      can_manage_chat:        true,   // ← field เดียวที่ true
      can_post_messages:      false,
      can_edit_messages:      false,
      can_delete_messages:    false,
      can_manage_video_chats: false,
      can_restrict_members:   false,
      can_promote_members:    false,
      can_change_info:        false,
      can_invite_users:       false,
      can_pin_messages:       false,
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error('promoteChatMember: ' + data.description);
  return data;
}

// ──────────────────────────────────────────
// 📌 demote กลับเป็น member ธรรมดา
// ──────────────────────────────────────────
async function demoteToMember(botToken, chatId, userId) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/promoteChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:                chatId,
      user_id:                userId,
      can_manage_chat:        false,
      can_post_messages:      false,
      can_edit_messages:      false,
      can_delete_messages:    false,
      can_manage_video_chats: false,
      can_restrict_members:   false,
      can_promote_members:    false,
      can_change_info:        false,
      can_invite_users:       false,
      can_pin_messages:       false,
    })
  });
  const data = await res.json();
  if (!data.ok) {
    console.warn(`⚠️ [Tag] demote ล้มเหลว user:${userId} → ${data.description}`);
  }
  return data.ok;
}

// ──────────────────────────────────────────
// 📌 ตั้ง custom title — retry สูงสุด 3 ครั้ง
//    (รอให้ Telegram propagate สิทธิ์ admin ก่อน)
// ──────────────────────────────────────────
async function setCustomTitle(botToken, chatId, userId, tag, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await sleep(attempt * 600); // 600ms, 1200ms, 1800ms
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setChatAdministratorCustomTitle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId, custom_title: tag })
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`✅ [Tag] set title "${tag}" สำเร็จ (attempt ${attempt})`);
      return data;
    }
    console.warn(`⚠️ [Tag] attempt ${attempt}/${retries} ล้มเหลว: ${data.description}`);
    if (attempt === retries) throw new Error('setChatAdministratorCustomTitle: ' + data.description);
  }
}

// ──────────────────────────────────────────
// 📌 setChatMemberTag — promote แล้ว set title
//    user จะเป็น admin ตลอดจนกว่าฉายาจะหมดอายุ
// ──────────────────────────────────────────
async function setChatMemberTag(botToken, chatId, userId, tag) {
  await promoteToAdmin(botToken, chatId, userId);
  await setCustomTitle(botToken, chatId, userId, tag);
}

// ──────────────────────────────────────────
// 📌 removeChatMemberTag — ลบ title แล้ว demote
// ──────────────────────────────────────────
async function removeChatMemberTag(botToken, chatId, userId) {
  // ลบ title ก่อน (ขณะยังเป็น admin)
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setChatAdministratorCustomTitle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId, custom_title: '' })
    });
    const data = await res.json();
    if (!data.ok) console.warn(`⚠️ [Tag] ลบ title ไม่สำเร็จ: ${data.description}`);
  } catch (e) {
    console.warn(`⚠️ [Tag] ลบ title error: ${e.message}`);
  }

  // demote กลับเป็น member
  await demoteToMember(botToken, chatId, userId);
}

// ──────────────────────────────────────────
// 📌 awardTag — บันทึก + แจกฉายาในคราวเดียว
// ──────────────────────────────────────────
async function awardTag(botToken, chatId, userId, username, fullName, tag, durationHours) {
  const expiresAt = durationHours > 0
    ? new Date(Date.now() + durationHours * 60 * 60 * 1000)
    : null;

  await setChatMemberTag(botToken, chatId, userId, tag);

  await Player.findOneAndUpdate(
    { userId, groupId: chatId.toString() },
    {
      $set: {
        username,
        fullName,
        currentTag:   tag,
        tagExpiresAt: expiresAt
      }
    },
    { upsert: true, new: true }
  );

  const expText = expiresAt
    ? expiresAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    : 'ถาวร';
  console.log(`🏷️ [Tag] แจก "${tag}" ให้ ${fullName} (${userId}) หมดอายุ: ${expText}`);
}

// ──────────────────────────────────────────
// 📌 recordKill
// ──────────────────────────────────────────
async function recordKill(userId, groupId, bossName, username, fullName) {
  await Player.findOneAndUpdate(
    { userId, groupId: groupId.toString() },
    {
      $set: { username, fullName },
      $inc: { killCount: 1 },
      $push: { killHistory: { $each: [{ bossName, killedAt: new Date() }], $slice: -50 } }
    },
    { upsert: true, new: true }
  );
}

// ──────────────────────────────────────────
// 📌 checkExpiredTags — เรียกทุก 1 นาที
// ──────────────────────────────────────────
async function checkExpiredTags(botToken) {
  try {
    const now = new Date();
    const expired = await Player.find({
      currentTag:   { $ne: null },
      tagExpiresAt: { $lte: now, $ne: null }
    });

    for (const player of expired) {
      await removeChatMemberTag(botToken, parseInt(player.groupId), player.userId);
      await Player.findOneAndUpdate(
        { _id: player._id },
        { $set: { currentTag: null, tagExpiresAt: null } }
      );
      console.log(`⏰ [TagExpiry] ลบ tag "${player.currentTag}" ของ ${player.fullName} (${player.userId}) ในกลุ่ม ${player.groupId}`);
    }

    if (expired.length > 0) {
      console.log(`⏰ [TagExpiry] ลบ tag หมดอายุทั้งหมด ${expired.length} รายการ`);
    }
  } catch (e) {
    console.error('❌ [TagExpiry] ล้มเหลว:', e.message);
  }
}

// ──────────────────────────────────────────
// 📌 getPlayerStats
// ──────────────────────────────────────────
async function getPlayerStats(userId, groupId) {
  return await Player.findOne({ userId, groupId: groupId.toString() });
}

module.exports = {
  Player,
  awardTag,
  recordKill,
  checkExpiredTags,
  getPlayerStats,
  setChatMemberTag,
  removeChatMemberTag,
};
