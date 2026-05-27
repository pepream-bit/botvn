const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ดึงค่าตัวแปรระบบความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

// 👥 ระบบ Whitelist รองรับผู้ใช้งานหลายคน (คั่นด้วยลูกน้ำ)
const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

// 🛰️ ระบบเชื่อมต่อหลายกลุ่ม รูปแบบ: ไอดีกลุ่ม:ชื่อกลุ่ม,ไอดีกลุ่ม:ชื่อกลุ่ม
const TARGET_GROUPS = [];
if (process.env.TARGET_GROUPS) {
  process.env.TARGET_GROUPS.split(',').forEach(item => {
    const parts = item.split(':');
    if (parts.length >= 2) {
      const id = parts[0].trim();
      const name = parts.slice(1).join(':').trim();
      TARGET_GROUPS.push({ id: parseInt(id), name: name });
    }
  });
}

if (!token || WHITELIST_IDS.length === 0 || TARGET_GROUPS.length === 0 || !LOG_CHANNEL_ID) {
  console.error('❌ CRITICAL ERROR: Environment Variables are missing or misconfigured on Render!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🛸 Alian Attack Engine Active! Authorized Operators: ${WHITELIST_IDS.length} | Connected Sectors: ${TARGET_GROUPS.length}`);

// ==========================================
// 1. เมนูหลักแสดงรายการกลุ่มทั้งหมดเมื่อกด /start
// ==========================================
function sendMainMenu(chatId) {
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ Sector: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);

  bot.sendMessage(chatId, "🛸 <b>ALIAN ATTACK COMMAND CENTER</b>\nSelect target sector to initialize control:", {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 2. จัดการระบบปุ่มกดเจาะจงกลุ่ม (Inline Keyboard)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'ACCESS DENIED: Unauthorized Identity Detected.', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // เมนูกลับหน้าหลัก
  if (data === 'back_to_main') {
    bot.deleteMessage(chatId, messageId).catch(() => {});
    sendMainMenu(chatId);
    return bot.answerCallbackQuery(query.id);
  }

  // เมื่อเลือกกลุ่มเสร็จแล้ว แสดงเมนูย่อยของกลุ่มนั้นๆ
  if (data.startsWith('select_group_')) {
    const groupId = data.replace('select_group_', '');
    const group = TARGET_GROUPS.find(g => g.id == groupId);

    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Sector Not Found.' });

    const submenu = [
      [
        { text: '🛸 Abduct (Ban)', callback_data: `opt_ban_${groupId}` },
        { text: '🟢 Release (Unban)', callback_data: `opt_unban_${groupId}` }
      ],
      [
        { text: '📢 Transmit Media / Text', callback_data: `opt_ann_${groupId}` }
      ],
      [
        { text: '⬅️ Back to Sectors', callback_data: 'back_to_main' }
      ]
    ];

    await bot.editMessageText(`🛰️ <b>Active Sector:</b> <code>${group.name}</code>\nSelect tactical operations for this environment:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: submenu }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // ประมวลผลเมื่อเลือก ฟังก์ชันย่อย (Ban / Unban / Announce)
  if (data.startsWith('opt_')) {
    const action = data.split('_')[1]; // ban, unban, ann
    const groupId = data.split('_')[2];
    
    if (action === 'ban') {
      bot.sendMessage(chatId, `🪐 <b>[BAN MODE] Sector:</b> <code>${groupId}</code>\nReply to this message with: <code>ID Reason</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unban') {
      bot.sendMessage(chatId, `🪐 <b>[UNBAN MODE] Sector:</b> <code>${groupId}</code>\nReply to this message with: <code>ID Reason</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'ann') {
      bot.sendMessage(chatId, `📢 <b>[TRANSMIT MODE] Sector:</b> <code>${groupId}</code>\nSend any text, photo, video, or media here to broadcast natively:`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    }
    bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 3. ระบบประมวลผลคำสั่งหลังกรอกข้อมูล (Force Reply Handling)
// ==========================================
bot.on('message', async (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  // ตรวจสอบระบบดักจับกล่องข้อความ Reply
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const promptText = msg.reply_to_message.text;
    
    // ดึงรหัสกลุ่มเป้าหมายจากข้อความคำสั่งของระบบบอทเอง
    const matchGroup = promptText.match(/Sector:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);

    // 🔴 ปฏิบัติการแบน (สไตล์สั้น กระชับ ตัวหนาสวยงาม ภาษาอังกฤษ)
    if (promptText.includes('[BAN MODE]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = args[0];
      const reason = args.slice(1).join(' ') || 'Violation of rules';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invalid Protocol:</b> User ID must be numerical.');
      }

      try {
        await bot.banChatMember(targetGroupId, targetUserId);
        
        // ประกาศสั้นๆ สวยงามในกลุ่มหลัก (ลบใน 1 นาที)
        const m = await bot.sendMessage(targetGroupId, `🪐 <b>ABDUCTED</b>\n🆔 <code>${targetUserId}</code>\n🚨 <b>Reason:</b> <b>${reason}</b>`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        // บันทึก Log ถาวรลง Channel
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ BAN LOG ]</b>\nSector ID: <code>${targetGroupId}</code>\nTarget ID: <code>${targetUserId}</code>\nReason: ${reason}\nOperator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target successfully abducted from sector.</b>`);
      } catch (e) {
        // แจ้งเตือนกรณีคนนั้นโดนแบนอยู่แล้ว หรือซ้ำซ้อน
        bot.sendMessage(msg.chat.id, `⚠️ <b>Target already liquidated</b>\nUser might already be banned or Alian Attack lacks admin privileges in this sector.\n\n<code>System info: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // 🟢 ปฏิบัติการปลดแบน
    if (promptText.includes('[UNBAN MODE]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = args[0];
      const reason = args.slice(1).join(' ') || 'Released by operator';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invalid Protocol:</b> User ID must be numerical.');
      }

      try {
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });

        // ประกาศปลดแบนสั้นๆ ในกลุ่มหลัก (ลบใน 1 นาที)
        const m = await bot.sendMessage(targetGroupId, `🪐 <b>RELEASED</b>\n🆔 <code>${targetUserId}</code>\n✨ <b>Access Restored</b>`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ UNBAN LOG ]</b>\nSector ID: <code>${targetGroupId}</code>\nTarget ID: <code>${targetUserId}</code>\nOperator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target released successfully.</b>`);
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ <b>Unable to complete release.</b>\n<code>System info: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // 📢 ปฏิบัติการประกาศกระจายเสียง (รองรับข้อความดิบ และสื่อทุกประเภทแบบไร้หัวเรื่อง)
    if (promptText.includes('[TRANSMIT MODE]')) {
      try {
        // ใช้ระบบคัดลอกข้อความดั้งเดิม (CopyMessage) ทำให้ส่ง Media, รูปภาพ, วิดีโอ ได้ตรงๆ ตามโครงสร้างเดิม
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        
        // ส่งบันทึกเข้าคลัง Log Channel
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ TRANSMISSION LOG ]</b>\nSector ID: <code>${targetGroupId}</code> initiated by operator <code>${msg.from.id}</code>:`, { parse_mode: 'HTML' });
        await bot.copyMessage(LOG_CHANNEL_ID, msg.chat.id, msg.message_id);

        bot.sendMessage(msg.chat.id, `✨ <b>Transmission broadcasted natively to targeted sector.</b>`);
      } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ <b>Transmission failed:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
  }
});

// เว็บเซิร์ฟเวอร์เพื่อให้ Render ตรวจสอบสถานะการออนไลน์
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);
