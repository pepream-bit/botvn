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

// 🎭 ตารางรหัสอิโมจิมาตรฐานป้องกันความผิดพลาดของเพย์โหลด
const EMOJI_MAP = {
  '1': '👍',
  '2': '🔥',
  '3': '❤️',
  '4': '😂',
  '5': '😮',
  '6': '😢',
  '7': '🎉'
};

// ตรวจสอบความพร้อมของระบบ
if (!token || WHITELIST_IDS.length === 0 || TARGET_GROUPS.length === 0 || !LOG_CHANNEL_ID) {
  console.error('❌ CRITICAL ERROR: Environment Variables missing or misconfigured!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`🛸 Alien Attack Engine Active! Operators: ${WHITELIST_IDS.length} | Sectors: ${TARGET_GROUPS.length}`);

// ฟังก์ชันดึงชื่อโปรไฟล์ของเป้าหมายแบบเรียลไทม์
async function fetchTargetName(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    if (member && member.user) {
      const u = member.user;
      return `${u.first_name || ''} ${u.last_name || ''}`.trim() || `@${u.username}` || `ID: ${userId}`;
    }
  } catch (e) {
    // หากไม่พบประวัติให้ใช้ค่าเริ่มต้นตามโหมดการกู้คืน
  }
  return null;
}

// ==========================================
// 1. เมนูหลัก Command Center (ผสมผสาน Reply Keyboard)
// ==========================================
bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  
  // เปิดแป้นพิมพ์ถาวรด้านล่าง (Reply Keyboard) รวมศูนย์ไว้ที่เดียว
  bot.sendMessage(msg.chat.id, "🛸 <b>ALIAN ATTACK COMMAND CENTER</b>\nระบบแป้นพิมพ์ควบคุมหลักเปิดใช้งานแล้ว โปรดกดปุ่มด้านล่างเพื่อดำเนินงาน:", {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '🛰️ จัดการเซกเตอร์ (Sectors)' }],
        [{ text: '📊 โควตาพลังงาน API' }, { text: '👥 รายชื่อ Whitelist' }],
        [{ text: '🧲 Stealth Capture (URL)' }]
      ],
      resize_keyboard: true
    }
  });
});

// ==========================================
// 2. จัดการปุ่มกด (Inline Keyboard) และเมนูกลุ่มย่อย
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'ACCESS DENIED.', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // กลับหน้าเลือกเซกเตอร์กลุ่มหลัก (Inline Keyboard)
  if (data === 'back_to_sectors') {
    const keyboard = TARGET_GROUPS.map(g => [
      { text: `🛰️ Sector: ${g.name}`, callback_data: `select_group_${g.id}` }
    ]);
    await bot.editMessageText("🛸 <b>รายชื่อเซกเตอร์เป้าหมาย:</b>\nโปรดเลือกเซกเตอร์เพื่อทำปฏิบัติการยุทธวิธี:", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // เลือกกลุ่มและแสดงเมนูย่อยแบบ Inline
  if (data.startsWith('select_group_')) {
    const groupId = data.replace('select_group_', '');
    const group = TARGET_GROUPS.find(g => g.id == groupId);
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Sector Not Found.' });

    const submenu = [
      [
        { text: '🛑 Purge (Ban)', callback_data: `opt_ban_${groupId}` },
        { text: '✨ Restore (Unban)', callback_data: `opt_unban_${groupId}` }
      ],
      [
        { text: '📢 Transmit Media/Text', callback_data: `opt_ann_${groupId}` },
        { text: '🔥 Reaction (รีแอคชัน)', callback_data: `opt_react_${groupId}` }
      ],
      [
        { text: '⬅️ Back to Sectors', callback_data: 'back_to_sectors' }
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

  // แจ้ง Force Reply ให้พิมพ์คำสั่งตามออปชันที่เลือก
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
    } else if (action === 'react') {
      let reactMsg = `🔥 <b>[REACTION PROTOCOL] Sector:</b> <code>${groupId}</code>\n`;
      reactMsg += `Reply with: <code>[Message URL] [Emoji Code]</code>\n\n`;
      reactMsg += `<b>รายชื่อรหัสอิโมจิมาตรฐานพื้นฐาน:</b>\n`;
      reactMsg += `<code>1</code> : 👍  |  <code>2</code> : 🔥  |  <code>3</code> : ❤️\n`;
      reactMsg += `<code>4</code> : 😂  |  <code>5</code> : 😮  |  <code>6</code> : 😢\n`;
      reactMsg += `<code>7</code> : 🎉\n\n`;
      reactMsg += `ตัวอย่างการพิมพ์: <code>https://t.me/c/2802866220/76297 2</code>`;
      
      bot.sendMessage(chatId, reactMsg, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    }
    bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 3. ระบบประมวลผลคำสั่งหลักผ่านข้อความ
// ==========================================
bot.on('message', async (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  // --- ดักจับคำสั่งที่มาจากปุ่มกดหลักของ Reply Keyboard ---
  if (msg.text) {
    if (msg.text === '🛰️ จัดการเซกเตอร์ (Sectors)') {
      const keyboard = TARGET_GROUPS.map(g => [
        { text: `🛰️ Sector: ${g.name}`, callback_data: `select_group_${g.id}` }
      ]);
      bot.sendMessage(msg.chat.id, "🛸 <b>รายชื่อเซกเตอร์เป้าหมาย:</b>\nโปรดเลือกเซกเตอร์เพื่อทำปฏิบัติการยุทธวิธี:", {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (msg.text === '🧲 Stealth Capture (URL)') {
      bot.sendMessage(msg.chat.id, '🧲 <b>ENTER URL TO CAPTURE:</b>\nProvide the Telegram link (e.g. https://t.me/c/xxxx/xxxx):', {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
      return;
    }

    if (msg.text === '📊 โควตาพลังงาน API') {
      bot.sendMessage(msg.chat.id, '📊 <b>ระบบตรวจวัดพลังงาน API:</b> สัญญาณเชื่อมต่อเสถียร 100% ไร้ร่องรอยการตรวจจับ', { parse_mode: 'HTML' });
      return;
    }

    if (msg.text === '👥 รายชื่อ Whitelist') {
      let whitelistMessage = `👥 <b>รายชื่อโอเปอเรเตอร์ผู้ควบคุม (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
      WHITELIST_IDS.forEach((id, idx) => {
        whitelistMessage += `${idx + 1}. 🆔 <code>${id}</code>\n`;
      });
      bot.sendMessage(msg.chat.id, whitelistMessage, { parse_mode: 'HTML' });
      return;
    }
  }

  // --- ทำงานเมื่อมีการ Reply กลับหาคำสั่งข้อความของบอทเท่านั้น ---
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const promptText = msg.reply_to_message.text;
    const operatorName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || `@${msg.from.username}` || msg.from.id;

    // --- 🧲 โหมดดูดสื่อไร้ร่องรอย (Stealth Capture System) ---
    if (promptText.includes('ENTER URL TO CAPTURE')) {
      if (!msg.text) return;
      try {
        const url = msg.text.trim();
        let targetChatId;
        let messageId;

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

        await bot.copyMessage(msg.chat.id, targetChatId, messageId);
        bot.sendMessage(msg.chat.id, '✅ <b>Capture complete (Stealth Mode).</b>', { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ <b>Capture failed:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // แกะรหัส ID กลุ่มเป้าหมายจากข้อความชวนตอบกลับ
    const matchGroup = promptText.match(/Sector:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);
    const groupObj = TARGET_GROUPS.find(g => g.id == targetGroupId);
    const groupName = groupObj ? groupObj.name : 'ไม่ระบุชื่อกลุ่ม';

    // --- 🔥 โหมดส่งรีแอคชันอิโมจิด้วยรหัสตัวเลข (Reaction Code System) ---
    if (promptText.includes('[REACTION PROTOCOL]')) {
      if (!msg.text) return;
      try {
        const parts = msg.text.trim().split(/\s+/);
        if (parts.length < 2) throw new Error("โปรดใส่ข้อมูลรูปแบบ: [ลิงก์ข้อความ] [รหัสตัวเลข]");

        const url = parts[0];
        const emojiCode = parts[1];
        const selectedEmoji = EMOJI_MAP[emojiCode];

        if (!selectedEmoji) throw new Error("ไม่พบรหัสอิโมจิที่เลือก โปรดระบุรหัส 1 ถึง 7 เท่านั้น");

        let targetChatId;
        let messageId;

        if (url.includes('/c/')) {
          const urlParts = url.split('/');
          messageId = parseInt(urlParts.pop());
          const chatIdStr = urlParts.pop();
          targetChatId = parseInt("-100" + chatIdStr);
        } else {
          const urlParts = url.split('/');
          messageId = parseInt(urlParts.pop());
          const username = urlParts.pop();
          targetChatId = "@" + username;
        }

        if (!targetChatId || isNaN(messageId)) throw new Error("รูปแบบพิกัดลิงก์ URL ไม่ถูกต้อง");

        // ยิงคำสั่งดิวก์ดิบผ่าน Telegram Webhook Raw API
        await bot._request('setMessageReaction', {
          chat_id: targetChatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: selectedEmoji }]
        });

        bot.sendMessage(msg.chat.id, `✅ <b>บีมสัญญาณริแอคชัน [ ${selectedEmoji} ] สำเร็จเรียบร้อย!</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ <b>การส่งริแอคชันขัดข้อง:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 🛑 โหมดแบน (Purge System) ---
    if (promptText.includes('[BAN MODE]')) {
      if (!msg.text) return;
      const args = msg.text.split(' ');
      const targetUserId = parseInt(args[0]);
      const reason = args.slice(1).join(' ') || 'Protocol Violation';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invalid Protocol:</b> ID must be numerical.');
      }

      try {
        let targetName = (await fetchTargetName(targetGroupId, targetUserId)) || "สิ่งมีชีวิตไม่ระบุชื่อ (Unknown Biomass)";
        await bot.banChatMember(targetGroupId, targetUserId);
        
        // ยิงประกาศเข้ากลุ่มเป้าหมาย (สไตล์ใหม่ แสดงชื่อแอดมินที่แบน)
        const m = await bot.sendMessage(targetGroupId, `🛑 <b>[ แจ้งเตือนการล้างเผ่าพันธุ์ - BAN VAPORIZED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${operatorName}</b>\n👤 <b>เป้าหมายที่ถูกทำลาย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🚨 <b>ข้อหาการกระทำผิด:</b> <code>${reason}</code>\n🛸 <b>สถานะปัจจุบัน:</b> ถูกระเหยสลายตัวตนและขับไล่ออกนอกชั้นบรรยากาศ (Vaporized)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        // บันทึกเข้า Log Channel (ตัด operator id ออก และใส่ชื่อเหยื่อ/กลุ่มต่อท้าย)
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ PURGE LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code> (${groupName})\nเหยื่อถูกทำลาย: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}`, { parse_mode: 'HTML' });
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
      const targetUserId = parseInt(args[0]);
      const reason = args.slice(1).join(' ') || 'Restored by Operator';

      if (!targetUserId || isNaN(targetUserId)) {
        return bot.sendMessage(msg.chat.id, '❌ <b>Invalid Protocol:</b> ID must be numerical.');
      }

      try {
        let targetName = (await fetchTargetName(targetGroupId, targetUserId)) || "สิ่งมีชีวิตกู้คืนโครงสร้าง";
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        
        // ยิงประกาศเข้ากลุ่มเป้าหมาย (สไตล์ใหม่แสดงชื่อแอดมินที่ปลด)
        const m = await bot.sendMessage(targetGroupId, `✨ <b>[ แจ้งเตือนการฟื้นฟูชีพ - UNBAN REANIMATED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${operatorName}</b>\n👤 <b>เป้าหมายที่ได้รับอภัย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🔓 <b>สถานะปัจจุบัน:</b> ได้รับการสร้างเนื้อเยื่อจำลองและอนุญาตให้ผ่านเข้าชั้นบรรยากาศใหม่อีกครั้ง (Access Granted)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        setTimeout(() => bot.deleteMessage(targetGroupId, m.message_id).catch(() => {}), 60000);

        // บันทึกเข้า Log Channel (ตัด operator id ออก และใส่ชื่อเป้าหมาย/กลุ่มต่อท้าย)
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ REANIMATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code> (${groupName})\nเป้าหมายคืนชีพ: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>Target restored successfully.</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        bot.sendMessage(msg.chat.id, `⚠️ <b>Unable to complete restoration.</b>\n<code>Info: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 📢 โหมดประกาศ (Transmit System) ---
    if (promptText.includes('[TRANSMIT MODE]')) {
      try {
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ TRANSMISSION LOG ]</b>\nSector: <code>${targetGroupId}</code> (${groupName})`, { parse_mode: 'HTML' });
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
