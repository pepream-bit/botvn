const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ระบบตั้งค่า & ตัวแปรความปลอดภัยจาก Render
const token = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

// 🌌 ระบบฐานข้อมูลดีเอ็นเอชั่วคราว (เก็บคีย์ Username แปลงเป็น ID และเก็บชื่อเล่น)
const usernameCache = {};

// 🔋 ระบบตรวจวัดการเรียกใช้งาน API ป้องกันการถูกระงับสัญญาณ
let apiCounter = 0;
const API_DAILY_MAX = 50000; // เพดานความปลอดภัยต่อวัน

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
// 1. เมนูหลัก Command Center (ภาษาไทย)
// ==========================================
function sendMainMenu(chatId) {
  apiCounter++;
  const keyboard = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์เป้าหมาย: ${g.name}`, callback_data: `select_group_${g.id}` }
  ]);

  // เพิ่มแถวปุ่มระบบข้อมูลเสริมภาษาไทย
  keyboard.push([
    { text: `📊 โควตาพลังงาน API`, callback_data: `view_api_limits` },
    { text: `👥 รายชื่อ Whitelist`, callback_data: `view_whitelist` }
  ]);

  bot.sendMessage(chatId, "🛸 <b>แผงควบคุมหลัก: กองทัพเอเลี่ยนต่างดาว (Alien Attack Machine)</b>\nยินดีต้อนรับท่านผู้บัญชาการ โปรดเลือกเซกเตอร์ดาวเทียมที่ต้องการเข้าควบคุม:", {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.onText(/\/start/, (msg) => {
  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  sendMainMenu(msg.chat.id);
});

// ==========================================
// 2. จัดการปุ่มกด (Inline Keyboard ภาษาไทย)
// ==========================================
bot.on('callback_query', async (query) => {
  if (!WHITELIST_IDS.includes(query.from.id)) {
    apiCounter++;
    return bot.answerCallbackQuery(query.id, { text: 'ปฏิเสธการเข้าถึง! โครงข่ายไม่รู้จักรหัสสัญญาณของคุณ', show_alert: true });
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // กลับหน้าหลัก
  if (data === 'back_to_main') {
    apiCounter += 2;
    bot.deleteMessage(chatId, messageId).catch(() => {});
    sendMainMenu(chatId);
    return bot.answerCallbackQuery(query.id);
  }

  // ดูสถานะ API
  if (data === 'view_api_limits') {
    apiCounter += 2;
    const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
    const bars = Math.round(pct / 10);
    const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
    
    await bot.sendMessage(chatId, `📊 <b>เครื่องตรวจวัดพลังงานสัญญาณขีดจำกัด API</b>\n\nหลอดพลังงาน: [<code>${barStr}</code>] ${pct}%\nดึงสัญญาณไปแล้ว: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง\n\n⚠️ <i>คำเตือน: โปรดควบคุมการยิงสัญญานไม่ให้ทะลุ 100% เพื่อป้องกันระนาบระบบป้องกันของ Telegram ตรวจจับและระงับสัญญาณระบบยานแม่</i>`, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  // ดูรายชื่อ Whitelist พร้อมชื่อเล่นจากแคช
  if (data === 'view_whitelist') {
    apiCounter += 2;
    let whitelistMessage = `👥 <b>รายชื่อโอเปอเรเตอร์ผู้ควบคุมยานแม่ (Whitelist)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    WHITELIST_IDS.forEach((id, idx) => {
      let name = "ร่างอวตารนิรนาม (ยังไม่พบประวัติพิมพ์ข้อความ)";
      for (const key in usernameCache) {
        if (usernameCache[key].id === id) {
          name = usernameCache[key].name;
          break;
        }
      }
      whitelistMessage += `${idx + 1}. 🆔 <code>${id}</code> [${name}]\n`;
    });
    whitelistMessage += `━━━━━━━━━━━━━━━━━━━━\n🛸 <i>สิทธิ์ในการสั่งการและแก้ไขชั้นบรรยากาศสูงสุด</i>`;
    
    await bot.sendMessage(chatId, whitelistMessage, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  // เลือกกลุ่มและแสดงเมนูย่อยระบบภาษาไทย
  if (data.startsWith('select_group_')) {
    apiCounter += 2;
    const groupId = data.replace('select_group_', '');
    const group = TARGET_GROUPS.find(g => g.id == groupId);
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'ไม่พบพิกัดเซกเตอร์เป้าหมายในแผนที่ดวงดาว' });

    const submenu = [
      [
        { text: '🛑 ล้างบางเผ่าพันธุ์ (Ban)', callback_data: `opt_ban_${groupId}` },
        { text: '✨ ชุบชีวิตเนื้อเยื่อ (Unban)', callback_data: `opt_unban_${groupId}` }
      ],
      [
        { text: '🧲 ดูดสื่อไร้ร่องรอย (Stealth Capture)', callback_data: `cmd_capture_url_${groupId}` }
      ],
      [
        { text: '📡 ยิงคลื่นประกาศ (Transmit)', callback_data: `opt_ann_${groupId}` },
        { text: '💬 ตอบกลับด้วยลิงก์ (Reply Link)', callback_data: `opt_replylink_${groupId}` }
      ],
      [
        { text: '⬅️ กลับสู่แผงควบคุมหลัก', callback_data: 'back_to_main' }
      ]
    ];

    await bot.editMessageText(`🛰️ <b>พิกัดเซกเตอร์ที่ล็อกไว้:</b> <code>${group.name}</code>\nโปรดเลือกคำสั่งโปรโตคอลการโจมตีหรือดูดกลืนข้อมูล:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: submenu }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // เรียกโหมดดูดสื่อประจำกลุ่ม (Stealth) - ยิงแยกห้องรายบุคคล
  if (data.startsWith('cmd_capture_url_')) {
    apiCounter += 2;
    const groupId = data.replace('cmd_capture_url_', '');
    bot.sendMessage(chatId, `🧲 <b>[QUANTUM TRACTOR BEAM] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nป้อนลิงก์เป้าหมาย Telegram ลงในเครื่องสแกนชีวภาพ (เช่น https://t.me/c/xxxx/xxxx):`, {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
    return bot.answerCallbackQuery(query.id);
  }

  // แจ้ง Force Reply ให้พิมพ์คำสั่งตามโหมดต่างๆ (ภาษาไทย)
  if (data.startsWith('opt_')) {
    apiCounter += 2;
    const parts = data.split('_');
    const action = parts[1];
    const groupId = parts[2];
    
    if (action === 'ban') {
      bot.sendMessage(chatId, `🛑 <b>[VAPORIZE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุเหยื่อที่จะล้างบาง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสเลขID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'unban') {
      bot.sendMessage(chatId, `✨ <b>[REANIMATE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุดีเอ็นเอที่จะชุบชีวิตกลับมา:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสเลขID เหตุผล</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'ann') {
      bot.sendMessage(chatId, `📡 <b>[BEAM TRANSMISSION] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งไฟล์ภาพ วิดีโอ หรือข้อความ เพื่อฝังตัวเข้าโครงข่ายประสาทของเซกเตอร์แบบเนทีฟ:`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    } else if (action === 'replylink') {
      bot.sendMessage(chatId, `💬 <b>[REPLY LINK PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์พิกัดข้อความ ตามด้วยข้อความที่จะตอบกลับแบบเนทีฟ\nรูปแบบ: <code>[ลิงก์ข้อความ] [เว้นวรรค] [ข้อความตอบกลับ]</code>\nตัวอย่าง: <code>https://t.me/c/123/456 เปิดระบบสแกนแล้วมนุษย์โลก</code>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true }
      });
    }
    bot.answerCallbackQuery(query.id);
  }
});

// ==========================================
// 3. ระบบประมวลผลสัญญาณข้อความและเก็บประวัติคีย์
// ==========================================
bot.on('message', async (msg) => {
  // 🛰️ ตรวจสแกนดีเอ็นเอผู้ส่งสารทุกคนในกลุ่มเก็บเข้าฐานข้อมูลชั่วคราว (เพื่อแปลง @username เป็นรหัสตัวเลข)
  if (msg.from && msg.from.username) {
    const usernameKey = msg.from.username.toLowerCase().replace('@', '');
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username;
    usernameCache[usernameKey] = {
      id: msg.from.id,
      name: fullName
    };
  }

  if (!WHITELIST_IDS.includes(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/start')) return;

  // ทำงานเมื่อมีการ Reply กลับหาบอทเท่านั้น
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const promptText = msg.reply_to_message.text;

    // --- 🧲 โหมดดูดสื่อไร้ร่องรอยแยกแชทเดี่ยว (Quantum Tractor Beam) ---
    if (promptText.includes('[QUANTUM TRACTOR BEAM]')) {
      if (!msg.text) return;
      apiCounter++;
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

        if (!targetChatId || isNaN(messageId)) throw new Error("พิกัดคลื่นพอร์ตดวงดาวไม่ถูกต้อง");

        apiCounter += 2;
        await bot.copyMessage(msg.from.id, targetChatId, messageId);
        bot.sendMessage(msg.from.id, '🛸 <b>กระบวนการดึงวัตถุเสร็จสิ้น ถูกส่งเข้าวงโคจรแชทส่วนตัวของคุณแล้ว ปิดระบบการสืบค้นย้อนกลับ 100%</b>', { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.from.id, `❌ <b>ยานแม่ปฏิเสธการดึงข้อมูล:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ระบบตรวจสอบ ID กลุ่มสำหรับการกระทำอื่นๆ ---
    const matchGroup = promptText.match(/พิกัดเซกเตอร์:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);

    // --- 💬 โหมดส่งข้อความตอบกลับผ่านลิงก์ (Reply Link System) ---
    if (promptText.includes('[REPLY LINK PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;
      try {
        const inputStr = msg.text.trim();
        const spaceIndex = inputStr.indexOf(' ');
        if (spaceIndex === -1) throw new Error("ตรวจพบข้อผิดพลาด: โปรดเคาะเว้นวรรคหลังลิงก์แล้วตามด้วยข้อความที่จะใช้ตอบกลับ");

        const url = inputStr.substring(0, spaceIndex).trim();
        const replyText = inputStr.substring(spaceIndex).trim();

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

        if (!targetChatId || isNaN(messageId)) throw new Error("รูปแบบพิกัดข้อความไม่สมบูรณ์");

        apiCounter += 2;
        await bot.sendMessage(targetGroupId, replyText, { reply_to_message_id: messageId });
        bot.sendMessage(msg.chat.id, `📡 <b>ส่งคลื่นสัญญานตอบกลับแบบเนทีฟไปยังข้อความลิงก์เป้าหมายเสร็จสิ้น!</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ <b>ปฏิบัติการขัดข้อง:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 🛑 โหมดแบนดีเอ็นเอ (Vaporize System รองรับ @username และ ID ขยายกรอบข้อความภาษาไทย) ---
    if (promptText.includes('[VAPORIZE PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;
      
      const args = msg.text.split(' ');
      const targetInput = args[0];
      const reason = args.slice(1).join(' ') || 'ตรวจพบการขัดขวางและต่อต้านกองทัพเอเลี่ยน';
      
      let targetUserId;
      let targetName = "สิ่งมีชีวิตไม่ระบุชื่อ (Unknown Biomass)";

      // ตรวจสอบว่าเป็น Username หรือไม่
      if (targetInput.startsWith('@')) {
        const usernameKey = targetInput.replace('@', '').toLowerCase();
        if (usernameCache[usernameKey]) {
          targetUserId = usernameCache[usernameKey].id;
          targetName = usernameCache[usernameKey].name;
        } else {
          apiCounter++;
          return bot.sendMessage(msg.chat.id, `❌ <b>ค้นหาเป้าหมายล้มเหลว:</b> ไม่พบข้อมูลรหัส ID สำหรับ <code>${targetInput}</code> ในหน่วยความจำบอท\n💡 <i>แนะนำ: ให้บุคคลคนนั้นส่งข้อความในกลุ่มแอดมินสักครั้งเพื่อให้บอทสแกนดีเอ็นเอ หรือเปลี่ยนไปใส่ตัวเลข ID ของผู้ใช้แทน</i>`, { parse_mode: 'HTML' });
        }
      } else {
        targetUserId = parseInt(targetInput);
        if (isNaN(targetUserId)) {
          apiCounter++;
          return bot.sendMessage(msg.chat.id, '❌ <b>รหัสไม่ถูกต้อง:</b> โปรดระบุข้อมูลเป็นข้อความแบบ @username หรือรหัสตัวเลข ID เท่านั้น', { parse_mode: 'HTML' });
        }
        for (const key in usernameCache) {
          if (usernameCache[key].id === targetUserId) {
            targetName = usernameCache[key].name;
            break;
          }
        }
      }

      try {
        apiCounter += 2;
        await bot.banChatMember(targetGroupId, targetUserId);
        
        const m = await bot.sendMessage(targetGroupId, `🛑 <b>[ แจ้งเตือนการล้างเผ่าพันธุ์ - BAN VAPORIZED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>หน่วยงานควบคุม:</b> กองทัพเอเลี่ยนต่างดาว (Alien Attack)\n👤 <b>เป้าหมายที่ถูกทำลาย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🚨 <b>ข้อหาการกระทำผิด:</b> <code>${reason}</code>\n🛸 <b>สถานะปัจจุบัน:</b> ถูกระเหยสลายตัวตนและขับไล่ออกนอกชั้นบรรยากาศ (Vaporized)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ VAPORIZATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code>\nเหยื่อถูกทำลาย: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}\nโอเปอเรเตอร์ผู้สั่งการ: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>ลบเผ่าพันธุ์เป้าหมายและบันทึกประวัติลงคลังข้อมูลแล้ว</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ขัดข้อง: เป้าหมายมีเกาะกำบังหนาแน่นหรือระบบขาดสิทธิ์แอดมินล้างบาง</b>\n<code>ข้อมูล: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ✨ โหมดปลดแบนดีเอ็นเอ (Reanimate System รองรับ @username และ ID ขยายกรอบข้อความภาษาไทย) ---
    if (promptText.includes('[REANIMATE PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;
      
      const args = msg.text.split(' ');
      const targetInput = args[0];
      const reason = args.slice(1).join(' ') || 'ได้รับการอภัยโทษสูงสุดจากยานแม่เอเลี่ยน';
      
      let targetUserId;
      let targetName = "สิ่งมีชีวิตกู้คืนโครงสร้าง";

      if (targetInput.startsWith('@')) {
        const usernameKey = targetInput.replace('@', '').toLowerCase();
        if (usernameCache[usernameKey]) {
          targetUserId = usernameCache[usernameKey].id;
          targetName = usernameCache[usernameKey].name;
        } else {
          apiCounter++;
          return bot.sendMessage(msg.chat.id, `❌ <b>ค้นหาเป้าหมายล้มเหลว:</b> ไม่พบข้อมูลรหัส ID สำหรับ <code>${targetInput}</code> ในหน่วยความจำชั่วคราว`, { parse_mode: 'HTML' });
        }
      } else {
        targetUserId = parseInt(targetInput);
        if (isNaN(targetUserId)) {
          apiCounter++;
          return bot.sendMessage(msg.chat.id, '❌ <b>รหัสไม่ถูกต้อง:</b> โปรดระบุข้อมูลเป็นข้อความแบบ @username หรือรหัสตัวเลข ID เท่านั้น', { parse_mode: 'HTML' });
        }
        for (const key in usernameCache) {
          if (usernameCache[key].id === targetUserId) {
            targetName = usernameCache[key].name;
            break;
          }
        }
      }

      try {
        apiCounter += 2;
        await bot.unbanChatMember(targetGroupId, targetUserId, { only_if_banned: true });
        
        const m = await bot.sendMessage(targetGroupId, `✨ <b>[ แจ้งเตือนการฟื้นฟูชีพ - UNBAN REANIMATED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>หน่วยงานควบคุม:</b> กองทัพเอเลี่ยนต่างดาว (Alien Attack)\n👤 <b>เป้าหมายที่ได้รับอภัย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🔓 <b>สถานะปัจจุบัน:</b> ได้รับการสร้างเนื้อเยื่อจำลองและอนุญาตให้ผ่านเข้าชั้นบรรยากาศใหม่อีกครั้ง (Access Granted)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ REANIMATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code>\nเป้าหมายคืนชีพ: <code>${targetUserId}</code> (${targetName})\nโอเปอเรเตอร์ผู้สั่งการ: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>ปฏิรูปโมเลกุลชุบชีวิตเนื้อเยื่อและเปิดด่านผ่านชั้นบรรยากาศสำเร็จ</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ขัดข้อง: ไม่สามารถแก้ไขรหัส DNA ของเป้าหมายในเซกเตอร์กลุ่มได้</b>\n<code>ข้อมูล: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 📢 โหมดประกาศคลื่นประสาท (Beam Transmission System - ไม่มีบันทึก Log แอบทำแบบเงียบๆ) ---
    if (promptText.includes('[BEAM TRANSMISSION]')) {
      apiCounter += 2;
      try {
        await bot.copyMessage(targetGroupId, msg.chat.id, msg.message_id);
        bot.sendMessage(msg.chat.id, `📡 <b>คลื่นสัญญาณถูกบีมแทรกซึมเข้าเน็ตเวิร์กเซกเตอร์กลุ่มเรียบร้อย ข้อมูลโทรมาตรถูกทำลายเกลี้ยง ล็อกดาวน์ไร้ประวัติสืบค้น</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ <b>คลื่นความถี่พลังงานหักล้างทำลายส่งสัญญาณไม่สำเร็จ:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
  }
});

// เปิดพอร์ตเชื่อมกับเว็บเซิร์ฟเวอร์เพื่อให้ Render ไม่ปิดระบบบอท
http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
