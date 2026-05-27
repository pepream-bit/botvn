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
  console.error('❌ CRITICAL ERROR: Environment Variables missing or misconfigured!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🛸 Alian Attack Engine Active! Operators: ${WHITELIST_IDS.length} | Sectors: ${TARGET_GROUPS.length}`);

// ==========================================
// 1. เมนูหลัก Command Center
// ==========================================
function sendMainMenu(chatId) {
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ Sector: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);
  
  // เพิ่มปุ่มดูดสื่อแบบไร้ร่องรอย (Stealth Mode)
  keyboard.push([{ text: '🧲 Stealth Capture (URL)', callback_data: 'cmd_capture_url' }]);

  bot.sendMessage(chatId, "🛸 <b>ALIAN ATTACK COMMAND CENTER</b>\nSelect operation:", {
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
    return bot.answerCallbackQuery(query.id, { text: 'ACCESS DENIED.', show_alert: true });
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

  // เลือกกลุ่มและแสดงเมนูย่อย
  if (data.startsWith('select_group_')) {
    const groupId = data.replace('select_group_', '');
    const group = TARGET_GROUPS.find(g => g.id == groupId);
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Sector Not Found.' });

    const submenu = [
      [
        // ปรับเปลี่ยนอิโมจิและคำให้ดุดัน เป็นทางการ
        { text: '🛑 Purge (Ban)', callback_data: `opt_ban_${groupId}` },
        { text: '✨ Restore (Unban)', callback_data: `opt_unban_${groupId}` }
      ],
      [
        { text: '📢 Transmit Media/Text', callback_data: `opt_ann_${groupId}` }
      ],
      [
        { text: '⬅️ Back to Command Center', callback_data: 'back_to_main' }
      ]
    ];

    await bot.editMessageText(`🛰️ <b>Active Sector:</b> <code>${group.name}</code>\nSelect tactical operation:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: submenu }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // เรียกโหมดดูดสื่อ (Stealth)
  if (data === 'cmd_capture_url') {
    bot.sendMessage(chatId, '🧲 <b>ENTER URL TO CAPTURE:</b>\nProvide the Telegram link (e.g. https://t.me/c/xxxx/xxxx):', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // แจ้ง Force Reply ให้พิมพ์คำสั่ง
  if (data.startsWith('opt_')) {
    const parts = data.split('_');
    const action = parts[1];
    const groupId = parts[2];
    
    if (action === 'ban') {
      bot.sendMessage(chatId, `🛑 <b>[BAN MODE] Sector:</b> <code>${groupId}</code>\nReply with: <code>ID Reason</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unban') {
      bot.sendMessage(chatId, `✨ <b>[UNBAN MODE] Sector:</b> <code>${groupId}</code>\nReply with: <code>ID Reason</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'ann') {
      bot.sendMessage(chatId, `📢 <b>[TRANSMIT MODE] Sector:</b> <code>${groupId}</code>\nSend media or text to broadcast natively:`, {
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

    // --- 🧲 โหมดดูดสื่อไร้ร่องรอย (Stealth Capture System) ---
    if (promptText.includes('ENTER URL TO CAPTURE')) {
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

        if (!targetChatId || isNaN(messageId)) throw new Error("Invalid URL format.");

        // ดึงสื่อตรงเข้าแชทส่วนตัว (ไม่มี Log / ไม่โผล่ในกลุ่ม)
        await bot.copyMessage(msg.chat.id, targetChatId, messageId);
        bot.sendMessage(msg.chat.id, '✅ <b>Capture complete (Stealth Mode).</b>', { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ <b>Capture failed:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ระบบตรวจสอบ ID กลุ่มสำหรับการกระทำอื่นๆ ---
    const matchGroup = promptText.match(/Sector:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);

    // --- 🛑 โหมดแบน (Purge System) ---
    if (promptText.includes('[BAN MODE]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = args[0];
      const reason = args.slice(1).join(' ') || 'Protocol Violation';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invalid Protocol:</b> ID must be numerical.');
      }

      try {
        await bot.banChatMember(targetGroupId, targetUserId);
        const m = await bot.sendMessage(targetGroupId, `🛑 <b>PURGED</b>\n🆔 <code>${targetUserId}</code>\n🚨 <b>Reason:</b> ${reason}`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ PURGE LOG ]</b>\nSector: <code>${targetGroupId}</code>\nTarget: <code>${targetUserId}</code>\nReason: ${reason}\nOperator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target successfully purged.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ <b>Target already liquidated or system lacks permission.</b>\n<code>Info: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ✨ โหมดปลดแบน (Restore System) ---
    if (promptText.includes('[UNBAN MODE]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = args[0];
      const reason = args.slice(1).join(' ') || 'Restored by Operator';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invalid Protocol:</b> ID must be numerical.');
      }

      try {
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        const m = await bot.sendMessage(targetGroupId, `✨ <b>RESTORED</b>\n🆔 <code>${targetUserId}</code>\n🔓 <b>Access Granted</b>`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ RESTORE LOG ]</b>\nSector: <code>${targetGroupId}</code>\nTarget: <code>${targetUserId}</code>\nOperator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target restored successfully.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ <b>Unable to complete restoration.</b>\n<code>Info: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 📢 โหมดประกาศ (Transmit System) ---
    if (promptText.includes('[TRANSMIT MODE]')) {
      try {
        // ส่งข้อความ/สื่อตรงๆ ไปที่กลุ่ม (ไม่มีคำประกาศนำหน้า)
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        
        // ส่ง Log การประกาศไปที่ Channel
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ TRANSMISSION LOG ]</b>\nSector: <code>${targetGroupId}</code> | Operator: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        await bot.copyMessage(LOG_CHANNEL_ID, msg.chat.id, msg.message_id);
        
        bot.sendMessage(msg.chat.id, `✨ <b>Transmission broadcasted natively.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ <b>Transmission failed:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
  }
});

// เปิดพอร์ตเชื่อมกับเว็บเซิร์ฟเวอร์เพื่อให้ Render ไม่ปิดระบบบอท
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);
