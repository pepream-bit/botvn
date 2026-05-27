const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

// 👥 ระบบ Whitelist (คั่นด้วยลูกน้ำ เช่น 12345,67890)
const WHITELIST_IDS = process.env.WHITELIST_IDS 
  ? process.env.WHITELIST_IDS.split(',').map(id => parseInt(id.trim())) 
  : [];

// 🛰️ ระบบ Multi-Group (รูปแบบ: ID:ชื่อ,ID:ชื่อ)
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

// ตรวจสอบความพร้อมของระบบ
if (!token || WHITELIST_IDS.length === 0 || TARGET_GROUPS.length === 0 || !LOG_CHANNEL_ID) {
  console.error('❌ CRITICAL ERROR: Interstellar Environment Variables missing!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🛸 Alien Invasion Engine Active! Overlords: ${WHITELIST_IDS.length} | Target Sectors: ${TARGET_GROUPS.length}`);

// ==========================================
// 1. เมนูหลัก Command Center
// ==========================================
function sendMainMenu(chatId) {
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ Sector: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);

  bot.sendMessage(chatId, "🛸 <b>ALIEN INVASION COMMAND MOTHERBOARD</b>\nSelect target sector to manipulate:", {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 2. จัดการปุ่มกด (Inline Keyboard)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'ACCESS DENIED. USER NOT RECOGNIZED BY MOTHERBOARD.', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // กลับหน้าหลัก
  if (data === 'back_to_main') {
    bot.deleteMessage(chatId, messageId).catch(() => {});
    sendMainMenu(chatId);
    return bot.answerCallbackQuery(query.id);
  }

  // เลือกกลุ่มและแสดงเมนูย่อย (ย้าย Stealth Capture เข้ามาในนี้แล้ว)
  if (data.startsWith('select_group_')) {
    const groupId = data.replace('select_group_', '');
    const group = TARGET_GROUPS.find(g => g.id == groupId);
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Sector Not Found in Galaxy Map.' });

    const submenu = [
      [
        { text: '🛑 Vaporize (Ban)', callback_data: `opt_ban_${groupId}` },
        { text: '✨ Reanimate (Unban)', callback_data: `opt_unban_${groupId}` }
      ],
      [
        { text: '🧲 Tractor Beam (Stealth Capture)', callback_data: `cmd_capture_url_${groupId}` }
      ],
      [
        { text: '📡 Beam Transmission', callback_data: `opt_ann_${groupId}` }
      ],
      [
        { text: '⬅️ Back to Motherboard', callback_data: 'back_to_main' }
      ]
    ];

    await bot.editMessageText(`🛸 <b>Target Sector Locked:</b> <code>${group.name}</code>\nSelect invasive protocol:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: submenu }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // เรียกโหมดดูดสื่อประจำกลุ่ม (Stealth)
  if (data.startsWith('cmd_capture_url_')) {
    const groupId = data.replace('cmd_capture_url_', '');
    bot.sendMessage(chatId, `🧲 <b>[QUANTUM TRACTOR BEAM] Sector:</b> <code>${groupId}</code>\nFeed the target Telegram link into the bio-scanner (e.g. https://t.me/c/xxxx/xxxx):`, {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // แจ้ง Force Reply ให้พิมพ์คำสั่งตามโหมดต่างๆ
  if (data.startsWith('opt_')) {
    const parts = data.split('_');
    const action = parts[1];
    const groupId = parts[2];
    
    if (action === 'ban') {
      bot.sendMessage(chatId, `🛑 <b>[VAPORIZE PROTOCOL] Sector:</b> <code>${groupId}</code>\nInput target identity to disintegrate: <code>ID Reason</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unban') {
      bot.sendMessage(chatId, `✨ <b>[REANIMATE PROTOCOL] Sector:</b> <code>${groupId}</code>\nInput target identity to restore: <code>ID Reason</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'ann') {
      bot.sendMessage(chatId, `📡 <b>[BEAM TRANSMISSION] Sector:</b> <code>${groupId}</code>\nLoad text or media capsule to infect the neural network natively:`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    }
    bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 3. ระบบประมวลผลคำสั่ง (API Optimized)
// ==========================================
bot.on('message', async (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  // ทำงานเมื่อมีการ Reply กลับหาบอทเท่านั้น
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const promptText = msg.reply_to_message.text;

    // --- 🧲 โหมดดูดสื่อไร้ร่องรอยแยกแชทเดี่ยว (Quantum Tractor Beam) ---
    if (promptText.includes('[QUANTUM TRACTOR BEAM]')) {
      if (!msg.text) return;
      try {
        const url = msg.text.trim();
        let targetChatId;
        let messageId;

        // แกะรหัส ID กลุ่มจาก URL
        if (url.includes('/c/')) {
          const parts = url.split('/');
          messageId = parseInt(parts.pop());
          const chatIdStr = parts.pop();
          targetChatId = parseInt("-100" + chatIdStr);
        } else {
          const parts = url.split('/');
          messageId = parseInt(parts.pop());
          const username = parts.pop();
          targetChatId = "@" + username;
        }

        if (!targetChatId || isNaN(messageId)) throw new Error("Invalid Interstellar Coordinate Format.");

        // ดึงสื่อตรงเข้า Private Chat ของ Operator ผู้สั่งการโดยตรง (ส่งเข้า msg.from.id แยกแชทใครแชทมัน ไม่ปนกัน)
        await bot.copyMessage(msg.from.id, targetChatId, messageId);
        bot.sendMessage(msg.from.id, '🛸 <b>Extraction complete. Object secured in your private orbit. No telemetry logged.</b>', { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.from.id, `❌ <b>Extraction aborted by Motherboard:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ระบบตรวจสอบ ID กลุ่มสำหรับการกระทำอื่นๆ ---
    const matchGroup = promptText.match(/Sector:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);

    // --- 🛑 โหมดแบน (Vaporize System) ---
    if (promptText.includes('[VAPORIZE PROTOCOL]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = args[0];
      const reason = args.slice(1).join(' ') || 'Organic Tissue Violation';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invasive Failure:</b> Target ID must be numeric values.');
      }

      try {
        await bot.banChatMember(targetGroupId, targetUserId);
        const m = await bot.sendMessage(targetGroupId, `🛑 <b>TARGET VAPORIZED</b>\n🆔 <code>${targetUserId}</code>\n🚨 <b>Protocol:</b> ${reason}`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ VAPORIZATION LOG ]</b>\nSector: <code>${targetGroupId}</code>\nTarget: <code>${targetUserId}</code>\nReason: ${reason}\nOperator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target successfully vaporized from existence.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ <b>Target immune or system lacks administrative clearance.</b>\n<code>Details: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ✨ โหมดปลดแบน (Reanimate System) ---
    if (promptText.includes('[REANIMATE PROTOCOL]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = args[0];
      const reason = args.slice(1).join(' ') || 'Re-allowed by Warlord';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invasive Failure:</b> Target ID must be numeric values.');
      }

      try {
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        const m = await bot.sendMessage(targetGroupId, `✨ <b>TARGET REANIMATED</b>\n🆔 <code>${targetUserId}</code>\n🔓 <b>Atmosphere Access Granted</b>`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ REANIMATION LOG ]</b>\nSector: <code>${targetGroupId}</code>\nTarget: <code>${targetUserId}</code>\nOperator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target tissue reanimated successfully.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ <b>Unable to patch target DNA structure.</b>\n<code>Details: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 📢 โหมดประกาศ (Beam Transmission System - ปิด Log ถาวร) ---
    if (promptText.includes('[BEAM TRANSMISSION]')) {
      try {
        // ยิงข้อความ/สื่อตรงๆ ไปที่กลุ่มเป้าหมายทันที
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        
        // [ระบบ LOG ถูกตัดออกเพื่อความปลอดภัยแบบไร้ร่องรอย]
        
        bot.sendMessage(msg.chat.id, `📡 <b>Signal beamed natively into Sector neural network. Telemetry wiped.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ <b>Transmission deflected:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
  }
});

// เปิดพอร์ตเชื่อมกับเว็บเซิร์ฟเวอร์เพื่อให้ Render ไม่ปิดระบบบอท
http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
