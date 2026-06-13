// ==========================================
// 🏷️ tagController.js — ระบบจัดการฉายา (Tag)
// ใช้ fetch ตรงไปยัง Telegram API เพราะ
// setChatMemberTag ยังไม่มีใน node-telegram-bot-api
// ==========================================

const mongoose = require('mongoose');

// ── Schema: เก็บข้อมูลผู้เล่นและฉายาที่ถืออยู่ ──
const PlayerSchema = new mongoose.Schema({
  userId:    { type: Number, required: true },          // Telegram User ID
  groupId:   { type: String, required: true },          // กลุ่มที่ผู้เล่นอยู่
  username:  { type: String, default: '' },
  fullName:  { type: String, default: '' },
  currentTag:     { type: String, default: null },      // ฉายาที่ถืออยู่ตอนนี้
  tagExpiresAt:   { type: Date,   default: null },      // เวลาหมดอายุฉายา
  killCount:      { type: Number, default: 0 },         // จำนวนบอสที่ฆ่าได้ทั้งหมด
  killHistory: [{
    bossName:  String,
    killedAt:  { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// index เพื่อค้นหาเร็ว
PlayerSchema.index({ userId: 1, groupId: 1 }, { unique: true });

const Player = mongoose.model('Player', PlayerSchema);

// ──────────────────────────────────────────
// 📌 ฟังก์ชันหลัก: แจกฉายาให้ผู้เล่น
// ──────────────────────────────────────────
async function setChatMemberTag(botToken, chatId, userId, tag) {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  // ── ขั้น 1: promote เป็น admin ──
  // ต้องส่ง can_manage_chat: true อย่างน้อย 1 field
  // Telegram ถือว่า "all false" = ไม่ได้ promote เลย → setChatAdministratorCustomTitle จะ fail
  const promoteRes = await fetch(`${baseUrl}/promoteChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:               chatId,
      user_id:               userId,
      can_manage_chat:       true,   // ← ต้องมี true อย่างน้อย 1 field
      can_post_messages:     false,
      can_edit_messages:     false,
      can_delete_messages:   false,
      can_manage_video_chats: false,
      can_restrict_members:  false,
      can_promote_members:   false,
      can_change_info:       false,
      can_invite_users:      false,
      can_pin_messages:      false,
    })
  });
  const promoteData = await promoteRes.json();
  if (!promoteData.ok) {
    throw new Error('promoteChatMember: ' + promoteData.description);
  }

  // ── รอให้ Telegram propagate สิทธิ์ก่อน ──
  await new Promise(r => setTimeout(r, 800));

  // ── ขั้น 2: ตั้ง custom title ──
  const titleRes = await fetch(`${baseUrl}/setChatAdministratorCustomTitle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:      chatId,
      user_id:      userId,
      custom_title: tag
    })
  });
  const titleData = await titleRes.json();
  if (!titleData.ok) {
    throw new Error('setChatAdministratorCustomTitle: ' + titleData.description);
  }
  return titleData;
}
// ──────────────────────────────────────────
// 📌 ฟังก์ชัน: ลบฉายาออก (ตั้งเป็นสตริงว่าง)
// ──────────────────────────────────────────
async function removeChatMemberTag(botToken, chatId, userId) {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  // ── ขั้น 1: ลบ custom title (ตั้งเป็นสตริงว่าง) ──
  const titleRes = await fetch(`${baseUrl}/setChatAdministratorCustomTitle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, user_id: userId, custom_title: '' })
  });
  const titleData = await titleRes.json();
  if (!titleData.ok) {
    console.warn(`⚠️ [TagController] ลบ title ไม่สำเร็จ user:${userId} → ${titleData.description}`);
  }

  // ── ขั้น 2: demote กลับเป็น member (ต้องส่ง true อย่างน้อย 1 field แล้ว toggle กลับ) ──
  // วิธีที่ถูก: promote ด้วย can_manage_chat:true ก่อน แล้ว promote ซ้ำด้วย false ทั้งหมด
  // แต่ Telegram Bot API จะ demote ได้เลยถ้าเรียก promoteChatMember ด้วย false ทั้งหมด
  // หลังจาก set title เป็นว่างแล้ว (ลำดับสำคัญมาก)
  const demoteRes = await fetch(`${baseUrl}/promoteChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:               chatId,
      user_id:               userId,
      can_manage_chat:       false,
      can_post_messages:     false,
      can_edit_messages:     false,
      can_delete_messages:   false,
      can_manage_video_chats: false,
      can_restrict_members:  false,
      can_promote_members:   false,
      can_change_info:       false,
      can_invite_users:      false,
      can_pin_messages:      false,
    })
  });
  const demoteData = await demoteRes.json();
  if (!demoteData.ok) {
    console.warn(`⚠️ [TagController] demote ไม่สำเร็จ user:${userId} → ${demoteData.description}`);
  }

  return titleData.ok;
}
// ──────────────────────────────────────────
// 📌 ฟังก์ชัน: บันทึก + แจกฉายาในคราวเดียว
// ──────────────────────────────────────────
async function awardTag(botToken, chatId, userId, username, fullName, tag, durationHours) {
  const expiresAt = durationHours > 0
    ? new Date(Date.now() + durationHours * 60 * 60 * 1000)
    : null; // null = ไม่มีหมดอายุ

  // 1. แจกฉายาผ่าน Telegram API
  await setChatMemberTag(botToken, chatId, userId, tag);

  // 2. บันทึกลง MongoDB (upsert = สร้างใหม่ถ้ายังไม่มี)
  await Player.findOneAndUpdate(
    { userId, groupId: chatId.toString() },
    {
      $set: {
        username,
        fullName,
        currentTag: tag,
        tagExpiresAt: expiresAt
      }
    },
    { upsert: true, new: true }
  );

  console.log(`🏷️ [TagController] แจก tag "${tag}" ให้ ${fullName} (${userId}) หมดอายุ: ${expiresAt ? expiresAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : 'ไม่มี'}`);
}

// ──────────────────────────────────────────
// 📌 ฟังก์ชัน: บันทึกการล่าบอส
// ──────────────────────────────────────────
async function recordKill(userId, groupId, bossName, username, fullName) {
  await Player.findOneAndUpdate(
    { userId, groupId: groupId.toString() },
    {
      $set: { username, fullName },
      $inc: { killCount: 1 },
      $push: { killHistory: { $each: [{ bossName, killedAt: new Date() }], $slice: -50 } } // เก็บแค่ 50 รายการล่าสุด
    },
    { upsert: true, new: true }
  );
}

// ──────────────────────────────────────────
// 📌 Cron-style: ตรวจและลบ Tag ที่หมดอายุ
// เรียกทุก 1 นาทีจาก index.js
// ──────────────────────────────────────────
async function checkExpiredTags(botToken) {
  try {
    const now = new Date();
    // หา player ที่มี tag และหมดอายุแล้ว
    const expired = await Player.find({
      currentTag: { $ne: null },
      tagExpiresAt: { $lte: now, $ne: null }
    });

    for (const player of expired) {
      // ลบ tag ใน Telegram
      await removeChatMemberTag(botToken, parseInt(player.groupId), player.userId);

      // ล้างข้อมูลใน DB
      await Player.findOneAndUpdate(
        { _id: player._id },
        { $set: { currentTag: null, tagExpiresAt: null } }
      );

      console.log(`⏰ [TagExpiry] ลบ tag "${player.currentTag}" ของ ${player.fullName} (${player.userId}) ในกลุ่ม ${player.groupId} แล้ว`);
    }

    if (expired.length > 0) {
      console.log(`⏰ [TagExpiry] ลบ tag หมดอายุทั้งหมด ${expired.length} รายการ`);
    }
  } catch (e) {
    console.error('❌ [TagExpiry] ตรวจสอบ tag หมดอายุล้มเหลว:', e.message);
  }
}

// ──────────────────────────────────────────
// 📌 ฟังก์ชัน: ดูสถิติผู้เล่น
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
  removeChatMemberTag
};
