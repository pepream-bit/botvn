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
// 1. เมนูหลัก Command Center (ภาษาไทย - Reply Keyboard)
// ==========================================
function sendMainMenu(chatId) {
  apiCounter++;
  
  // สร้างแป้นพิมพ์ถาวรด้านล่าง (Reply Keyboard) สำหรับเซกเตอร์กลุ่ม
  const keyboardButtons = TARGET_GROUPS.map(g => [
    { text: `🛰️ เซกเตอร์: ${g.name}` }
  ]);

  // เพิ่มเมนูระบบเสริมไว้ที่แถวล่างสุด
  keyboardButtons.push([
    { text: `📊 โควตาพลังงาน API` },
    { text: `👥 รายชื่อ Whitelist` }
  ]);

  bot.sendMessage(chatId, "🛸 <b>แผงควบคุมหลัก: กองทัพเอเลี่ยนต่างดาว (Alien Attack Machine)</b>\nยินดีต้อนรับท่านผู้บัญชาการ โปรดกดเลือกเซกเตอร์เป้าหมายจากแผงควบคุมด้านล่างเพื่อสั่งการ:", {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: keyboardButtons,
      resize_keyboard: true
    }
  });
}

// ==========================================
// 2. ระบบประมวลผลข้อความและแป้นพิมพ์ควบคุมหลัก
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

  // คัดกรองเฉพาะผู้ควบคุมที่ติด Whitelist เท่านั้น
  if (!WHITELIST_IDS.includes(msg.from.id)) return;

  // --- ประมวลผลกรณีที่มีตัวอักษรเข้ามา (ตรวจจับปุ่มเมนู Reply Keyboard) ---
  if (msg.text) {
    const text = msg.text.trim();

    if (text === '/start' || text === '⬅️ กลับสู่แผงควบคุมหลัก') {
      sendMainMenu(msg.chat.id);
      return;
    }

    // ฟังก์ชันดูสถานะพลังงาน API
    if (text === '📊 โควตาพลังงาน API') {
      apiCounter++;
      const pct = Math.min(100, Math.round((apiCounter / API_DAILY_MAX) * 100));
      const bars = Math.round(pct / 10);
      const barStr = "🟩".repeat(bars) + "⬜".repeat(10 - bars);
      
      await bot.sendMessage(msg.chat.id, `📊 <b>เครื่องตรวจวัดพลังงานสัญญาณขีดจำกัด API</b>\n\nหลอดพลังงาน: [<code>${barStr}</code>] ${pct}%\nดึงสัญญาณไปแล้ว: <code>${apiCounter}</code> / <code>${API_DAILY_MAX}</code> ครั้ง\n\n⚠️ <i>คำเตือน: โปรดควบคุมการยิงสัญญานไม่ให้ทะลุ 100% เพื่อป้องกันระนาบระบบป้องกันของ Telegram ตรวจจับและระงับสัญญาณระบบยานแม่</i>`, { parse_mode: 'HTML' });
      return;
    }

    // ฟังก์ชันดูรายชื่อ Whitelist
    if (text === '👥 รายชื่อ Whitelist') {
      apiCounter++;
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
      
      await bot.sendMessage(msg.chat.id, whitelistMessage, { parse_mode: 'HTML' });
      return;
    }

    // ฟังก์ชันเมื่อกดเลือกกลุ่มกลุ่มใดกลุ่มหนึ่ง
    if (text.startsWith('🛰️ เซกเตอร์: ')) {
      const groupName = text.replace('🛰️ เซกเตอร์: ', '').trim();
      const group = TARGET_GROUPS.find(g => g.name === groupName);
      if (!group) {
        bot.sendMessage(msg.chat.id, '❌ ไม่พบพิกัดเซกเตอร์เป้าหมายในแผนที่ดวงดาว');
        return;
      }

      // เปลี่ยนแป้นพิมพ์ด้านล่างเป็นชุดคำสั่งปฏิบัติการของกลุ่มนั้นๆ
      const submenuButtons = [
        [{ text: `🛑 ล้างบาง (Ban) - ${group.name}` }, { text: `✨ ชุบชีวิต (Unban) - ${group.name}` }],
        [{ text: `🧲 ดูดสื่อ (Stealth) - ${group.name}` }, { text: `📡 ประกาศ (Transmit) - ${group.name}` }],
        [{ text: `💬 ตอบกลับลิงก์ (Reply) - ${group.name}` }, { text: `🔥 รีแอคชัน (Reaction) - ${group.name}` }],
        [{ text: '⬅️ กลับสู่แผงควบคุมหลัก' }]
      ];

      bot.sendMessage(msg.chat.id, `🛰️ <b>พิกัดเซกเตอร์ที่ล็อกไว้:</b> <code>${group.name}</code>\nโปรดเลือกคำสั่งโปรโตคอลการโจมตีหรือดูดกลืนข้อมูลจากแผงคุมด้านล่าง:`, {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: submenuButtons,
          resize_keyboard: true
        }
      });
      return;
    }

    // ตรวจสอบการกดปุ่มสั่งการปฏิบัติการย่อยในกลุ่มเป้าหมาย
    let actionFound = false;
    for (const group of TARGET_GROUPS) {
      if (text.includes(`- ${group.name}`)) {
        actionFound = true;
        const groupId = group.id;

        if (text.startsWith('🛑 ล้างบาง')) {
          bot.sendMessage(msg.chat.id, `🛑 <b>[VAPORIZE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุเหยื่อที่จะล้างบาง:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสเลขID เหตุผล</code>`, {
            parse_mode: 'HTML', reply_markup: { force_reply: true }
          });
        } else if (text.startsWith('✨ ชุบชีวิต')) {
          bot.sendMessage(msg.chat.id, `✨ <b>[REANIMATE PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งคำสั่งระบุดีเอ็นเอที่จะชุบชีวิตกลับมา:\nรูปแบบ: <code>@username เหตุผล</code> หรือ <code>รหัสเลขID เหตุผล</code>`, {
            parse_mode: 'HTML', reply_markup: { force_reply: true }
          });
        } else if (text.startsWith('🧲 ดูดสื่อ')) {
          bot.sendMessage(msg.chat.id, `🧲 <b>[QUANTUM TRACTOR BEAM] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nป้อนลิงก์เป้าหมาย Telegram ลงในเครื่องสแกนชีวภาพ (เช่น https://t.me/c/xxxx/xxxx):`, {
            parse_mode: 'HTML', reply_markup: { force_reply: true }
          });
        } else if (text.startsWith('📡 ประกาศ')) {
          bot.sendMessage(msg.chat.id, `📡 <b>[BEAM TRANSMISSION] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งไฟล์ภาพ วิดีโอ หรือข้อความ เพื่อฝังตัวเข้าโครงข่ายประสาทของเซกเตอร์แบบเนทีฟ:`, {
            parse_mode: 'HTML', reply_markup: { force_reply: true }
          });
        } else if (text.startsWith('💬 ตอบกลับลิงก์')) {
          bot.sendMessage(msg.chat.id, `💬 <b>[REPLY LINK PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์พิกัดข้อความ ตามด้วยข้อความที่จะตอบกลับแบบเนทีฟ\nรูปแบบ: <code>[ลิงก์ข้อความ] [เว้นวรรค] [ข้อความตอบกลับ]</code>\nตัวอย่าง: <code>https://t.me/c/123/456 เปิดระบบสแกนแล้วมนุษย์โลก</code>`, {
            parse_mode: 'HTML', reply_markup: { force_reply: true }
          });
        } else if (text.startsWith('🔥 รีแอคชัน')) {
          bot.sendMessage(msg.chat.id, `🔥 <b>[REACTION PROTOCOL] พิกัดเซกเตอร์:</b> <code>${groupId}</code>\nส่งลิงก์พิกัดข้อความ ตามด้วยอิโมจิที่จะให้บอทกดรีแอคชัน\nรูปแบบ: <code>[ลิงก์ข้อความ] [เว้นวรรค] [อิโมจิ]</code>\nตัวอย่าง: <code>https://t.me/c/2802866220/76297 👍</code>`, {
            parse_mode: 'HTML', reply_markup: { force_reply: true }
          });
        }
        break;
      }
    }
    if (actionFound) return;
  }

  // --- 3. ระบบทำงานตอบกลับจาก Force Reply (รองรับสื่อและลิงก์ข้อความทุกประเภท) ---
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

    // ตรวจหา ID กลุ่มเป้าหมายจากข้อความชวนตอบกลับ
    const matchGroup = promptText.match(/พิกัดเซกเตอร์:\s*(-?\d+)/);
    if (!matchGroup) return;
    const targetGroupId = parseInt(matchGroup[1]);
    const groupObj = TARGET_GROUPS.find(g => g.id === targetGroupId);
    const groupName = groupObj ? groupObj.name : 'ไม่ระบุกลุ่ม';

    // ดึงชื่อของเอเลี่ยน (Admin) ผู้พิมคำสั่งลงมือทำรายการ
    const alienOperatorName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || `@${msg.from.username}` || msg.from.id;

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

    // --- 🔥 โหมดส่งรีแอคชันอิโมจิผ่านลิงก์ (Reaction System) ---
    if (promptText.includes('[REACTION PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;
      try {
        const inputStr = msg.text.trim();
        const spaceIndex = inputStr.indexOf(' ');
        if (spaceIndex === -1) throw new Error("ตรวจพบข้อผิดพลาด: โปรดเคาะเว้นวรรคหลังลิงก์แล้วตามด้วยอิโมจิที่จะกด");

        const url = inputStr.substring(0, spaceIndex).trim();
        const emojiText = inputStr.substring(spaceIndex).trim();

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
        // เรียกใช้งานผ่าน Telegram Raw API เพื่อความยืดหยุ่นในการรองรับ Reaction ทุกเวอร์ชัน
        await bot._request('setMessageReaction', {
          chat_id: targetChatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: emojiText }]
        });

        bot.sendMessage(msg.chat.id, `🔥 <b>ยานแม่บีมคลื่นรีแอคชันอิโมจิ [ ${emojiText} ] ไปยังข้อความลิงก์เรียบร้อยแล้ว!</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `❌ <b>ปฏิบัติการส่งรีแอคชันขัดข้อง:</b>\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 🛑 โหมดแบนดีเอ็นเอ (Vaporize System) ---
    if (promptText.includes('[VAPORIZE PROTOCOL]')) {
      if (!msg.text) return;
      apiCounter++;
      
      const args = msg.text.split(' ');
      const targetInput = args[0];
      const reason = args.slice(1).join(' ') || 'ตรวจพบการขัดขวางและต่อต้านกองทัพเอเลี่ยน';
      
      let targetUserId;
      let targetName = "สิ่งมีชีวิตไม่ระบุชื่อ (Unknown Biomass)";

      if (targetInput.startsWith('@')) {
        const usernameKey = targetInput.replace('@', '').toLowerCase();
        if (usernameCache[usernameKey]) {
          targetUserId = usernameCache[usernameKey].id;
          targetName = usernameCache[usernameKey].name;
        } else {
          apiCounter++;
          return bot.sendMessage(msg.chat.id, `❌ <b>ค้นหาเป้าหมายล้มเหลว:</b> ไม่พบข้อมูลรหัส ID สำหรับ <code>${targetInput}</code> ในหน่วยความจำบอท\n💡 <i>แนะนำ: ให้บุคคลคนนั้นพิมพ์ข้อความในกลุ่มขณะที่บอทออนไลน์เพื่อให้หน่วยสแกนจดจำ หรือใส่เป็นเลข ID แทน</i>`, { parse_mode: 'HTML' });
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
        
        // ยิงข้อความประกาศจับลงกลุ่ม และเปลี่ยนชื่อเป็นแอดมินเอเลี่ยนผู้กดแบน
        const m = await bot.sendMessage(targetGroupId, `🛑 <b>[ แจ้งเตือนการล้างเผ่าพันธุ์ - BAN VAPORIZED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n👤 <b>เป้าหมายที่ถูกทำลาย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🚨 <b>ข้อหาการกระทำผิด:</b> <code>${reason}</code>\n🛸 <b>สถานะปัจจุบัน:</b> ถูกระเหยสลายตัวตนและขับไล่ออกนอกชั้นบรรยากาศ (Vaporized)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        // บันทึก Log ข้อมูลแบบถอดโอเปอเรเตอร์ ID ออก และใส่ชื่อกลุ่มกับเป้าหมายตามหลังตัวเลข ID
        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ VAPORIZATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code> (${groupName})\nเหยื่อถูกทำลาย: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>ลบเผ่าพันธุ์เป้าหมายและบันทึกประวัติลงคลังข้อมูลแล้ว</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ขัดข้อง: เป้าหมายมีเกาะกำบังหนาแน่นหรือระบบขาดสิทธิ์แอดมินล้างบาง</b>\n<code>ข้อมูล: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- ✨ โหมดปลดแบนดีเอ็นเอ (Reanimate System) ---
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
        
        // ยิงข้อความประกาศฟื้นฟูลงกลุ่ม และเปลี่ยนชื่อเป็นแอดมินเอเลี่ยนผู้กดปลดแบน
        const m = await bot.sendMessage(targetGroupId, `✨ <b>[ แจ้งเตือนการฟื้นฟูชีพ - UNBAN REANIMATED ]</b>\n━━━━━━━━━━━━━━━━━━━━\n👽 <b>เอเลี่ยนผู้ควบคุม:</b> <b>${alienOperatorName}</b>\n👤 <b>เป้าหมายที่ได้รับอภัย:</b> <b>${targetName}</b>\n🆔 <b>รหัสพันธุกรรม (ID):</b> <code>${targetUserId}</code>\n🔓 <b>สถานะปัจจุบัน:</b> ได้รับการสร้างเนื้อเยื่อจำลองและอนุญาตให้ผ่านเข้าชั้นบรรยากาศใหม่อีกครั้ง (Access Granted)\n━━━━━━━━━━━━━━━━━━━━\n⏰ <i>คำเตือน: ข้อความสแกนนี้จะระเบิดตัวเองใน 60 วินาที...</i>`, { parse_mode: 'HTML' });
        
        setTimeout(() => {
          apiCounter++;
          bot.deleteMessage(targetGroupId, m.message_id).catch(() => {});
        }, 60000);

        // บันทึก Log ข้อมูลแบบถอดโอเปอเรเตอร์ ID ออก และใส่ชื่อกลุ่มกับเป้าหมายตามหลังตัวเลข ID
        apiCounter += 2;
        await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ REANIMATION LOG ]</b>\nเซกเตอร์กลุ่ม: <code>${targetGroupId}</code> (${groupName})\nเป้าหมายคืนชีพ: <code>${targetUserId}</code> (${targetName})\nเหตุผลความผิด: ${reason}`, { parse_mode: 'HTML' });
        bot.sendMessage(msg.chat.id, `✅ <b>ปฏิรูปโมเลกุลชุบชีวิตเนื้อเยื่อและเปิดด่านผ่านชั้นบรรยากาศสำเร็จ</b>`, { parse_mode: 'HTML' });
      } catch (e) {
        apiCounter++;
        bot.sendMessage(msg.chat.id, `⚠️ <b>ขัดข้อง: ไม่สามารถแก้ไขรหัส DNA ของเป้าหมายในเซกเตอร์กลุ่มได้</b>\n<code>ข้อมูล: ${e.message}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // --- 📢 โหมดประกาศคลื่นประสาท (Beam Transmission System) ---
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

// เปิดพอร์ตเชื่อมกับเว็บเซิร์ฟเวอร์เพื่อให้ Render ไม่ปิดระบบบอทอัตโนมัติ
http.createServer((req, res) => res.end('SYSTEM_ONLINE')).listen(process.env.PORT || 3000);
