const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ดึงค่าตัวแปรลับจาก Render (จะไม่แสดงรหัสใน GitHub)
const token = process.env.BOT_TOKEN;
const MY_USER_ID = parseInt(process.env.MY_USER_ID);
const TARGET_GROUP_ID = parseInt(process.env.TARGET_GROUP_ID);
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

if (!token || !MY_USER_ID || !TARGET_GROUP_ID || !LOG_CHANNEL_ID) {
  console.error('❌ ข้อมูล Environment Variables ไม่ครบถ้วน กรุณาตรวจสอบบน Render');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log('🤖 DARK VN BOT เริ่มทำงาน (Inline Keyboard + Auto Log)...');

// ==========================================
// ฟังก์ชันจัดการ การแบน (แยกออกมาเพื่อให้โค้ดเป็นระเบียบ)
// ==========================================
async function executeBan(targetUserId, reason, chatId) {
  if (!targetUserId || isNaN(targetUserId)) {
    return bot.sendMessage(chatId, '❌ รูปแบบไม่ถูกต้อง: ไอดีต้องเป็นตัวเลขเท่านั้น', { parse_mode: 'HTML' });
  }
  const timeStamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  try {
    await bot.banChatMember(TARGET_GROUP_ID, targetUserId);
    
    // ประกาศในกลุ่ม (ลบทิ้งใน 1 นาที)
    const m = await bot.sendMessage(TARGET_GROUP_ID, `⛔ <b>BANNED & RESTRICTED</b>\n👤 ID: <code>${targetUserId}</code>\n📝 เหตุผล: ${reason}`, { parse_mode: 'HTML' });
    setTimeout(() => bot.deleteMessage(TARGET_GROUP_ID, m.message_id).catch(() => {}), 60000);
    
    // ส่ง Log ถาวร
    await bot.sendMessage(LOG_CHANNEL_ID, 
      `📜 <b>[ SYSTEM LOG - BAN ]</b>\n` +
      `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
      `🔴 <b>การกระทำ:</b> สั่งแบนผู้ใช้งาน\n` +
      `👤 <b>เป้าหมาย ID:</b> <code>${targetUserId}</code>\n` +
      `📝 <b>เหตุผล:</b> <i>${reason}</i>\n` +
      `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
      `⏰ <b>เวลา:</b> ${timeStamp} น.`, 
      { parse_mode: 'HTML' }
    );

    bot.sendMessage(chatId, `✅ แบนและส่ง Log สำเร็จ: <code>${targetUserId}</code>`, { parse_mode: 'HTML' });
  } catch (e) { 
    bot.sendMessage(chatId, `❌ Error:\n<code>${e.message}</code>`, { parse_mode: 'HTML' }); 
  }
}

// ==========================================
// ฟังก์ชันจัดการ การปลดแบน
// ==========================================
async function executeUnban(targetUserId, reason, chatId) {
  if (!targetUserId || isNaN(targetUserId)) {
    return bot.sendMessage(chatId, '❌ รูปแบบไม่ถูกต้อง: ไอดีต้องเป็นตัวเลขเท่านั้น', { parse_mode: 'HTML' });
  }
  const timeStamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  try {
    await bot.unbanChatMember(TARGET_GROUP_ID, targetUserId, { only_if_banned: true });
    
    const m = await bot.sendMessage(TARGET_GROUP_ID, `🟢 <b>ACCESS RE-GRANTED</b>\n👤 ID: <code>${targetUserId}</code>\n📝 ผู้ใช้งานถูกปลดแบนเรียบร้อย`, { parse_mode: 'HTML' });
    setTimeout(() => bot.deleteMessage(TARGET_GROUP_ID, m.message_id).catch(() => {}), 60000);

    await bot.sendMessage(LOG_CHANNEL_ID, 
      `📜 <b>[ SYSTEM LOG - UNBAN ]</b>\n` +
      `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
      `🟢 <b>การกระทำ:</b> ปลดแบนผู้ใช้งาน\n` +
      `👤 <b>เป้าหมาย ID:</b> <code>${targetUserId}</code>\n` +
      `📝 <b>เหตุผล:</b> <i>${reason}</i>\n` +
      `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
      `⏰ <b>เวลา:</b> ${timeStamp} น.`, 
      { parse_mode: 'HTML' }
    );

    bot.sendMessage(chatId, `✅ ปลดแบนและส่ง Log สำเร็จ: <code>${targetUserId}</code>`, { parse_mode: 'HTML' });
  } catch (e) { 
    bot.sendMessage(chatId, `❌ Error:\n<code>${e.message}</code>`, { parse_mode: 'HTML' }); 
  }
}

// ==========================================
// 1. ส่งหน้าต่างปุ่มกด Inline Keyboard เมื่อพิมพ์ /start
// ==========================================
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== MY_USER_ID) return;
  
  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔴 แบน (Ban)', callback_data: 'cmd_ban' },
          { text: '🟢 ปลดแบน (Unban)', callback_data: 'cmd_unban' }
        ],
        [
          { text: '📢 ประกาศข้อความลงกลุ่ม', callback_data: 'cmd_announce' }
        ]
      ]
    }
  };
  
  bot.sendMessage(msg.chat.id, "🤖 <b>ระบบ DARK VN BOT ออนไลน์!</b>\nกรุณากดเลือกเมนูที่ต้องการใช้งานด้านล่างนี้:", options);
});

// ==========================================
// 2. จัดการคำสั่งเมื่อคุณกดปุ่มบนจอ
// ==========================================
bot.on('callback_query', (query) => {
  if (query.from.id !== MY_USER_ID) return bot.answerCallbackQuery(query.id, { text: 'ไม่มีสิทธิ์ใช้งาน', show_alert: true });
  
  const chatId = query.message.chat.id;
  
  // ตั้งค่าให้บอทบังคับให้คุณกด Reply ตัวมันเองอัตโนมัติ (Force Reply)
  if (query.data === 'cmd_ban') {
    bot.sendMessage(chatId, '🔴 <b>โหมดแบนผู้ใช้</b>\nกรุณาพิมพ์:\n<code>ไอดี เหตุผล</code>\n(เช่น 123456789 สแปมกลุ่ม)', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
  } else if (query.data === 'cmd_unban') {
    bot.sendMessage(chatId, '🟢 <b>โหมดปลดแบนผู้ใช้</b>\nกรุณาพิมพ์:\n<code>ไอดี เหตุผล</code>\n(เช่น 123456789 ขอโอกาส)', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
  } else if (query.data === 'cmd_announce') {
    bot.sendMessage(chatId, '📢 <b>โหมดประกาศลงกลุ่ม</b>\nกรุณาพิมพ์ข้อความที่คุณต้องการให้บอทประกาศลงในกลุ่มหลัก:', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
  }
  
  // ส่งสัญญาณให้ Telegram รู้ว่ากดปุ่มแล้ว
  bot.answerCallbackQuery(query.id);
});

// ==========================================
// 3. จัดการข้อความที่คุณพิมพ์ส่งกลับมา (หลังกดปุ่ม)
// ==========================================
bot.on('message', async (msg) => {
  if (msg.from.id !== MY_USER_ID) return;
  if (!msg.text) return;
  if (msg.text.startsWith('/start')) return;

  // ตรวจสอบว่าคุณพิมพ์ตอบกลับ (Reply) ข้อความจากระบบปุ่มกดหรือไม่
  if (msg.reply_to_message && msg.reply_to_message.text) {
     const promptText = msg.reply_to_message.text;
     
     // ถ้าตอบกลับในโหมด "แบน"
     if (promptText.includes('โหมดแบนผู้ใช้')) {
       const args = msg.text.split(' ');
       const targetUserId = args[0];
       const reason = args.slice(1).join(' ') || 'ไม่ระบุสาเหตุ';
       await executeBan(targetUserId, reason, msg.chat.id);
       return;
     }
     
     // ถ้าตอบกลับในโหมด "ปลดแบน"
     if (promptText.includes('โหมดปลดแบนผู้ใช้')) {
       const args = msg.text.split(' ');
       const targetUserId = args[0];
       const reason = args.slice(1).join(' ') || 'ไม่ระบุสาเหตุ';
       await executeUnban(targetUserId, reason, msg.chat.id);
       return;
     }
     
     // ถ้าตอบกลับในโหมด "ประกาศ"
     if (promptText.includes('โหมดประกาศลงกลุ่ม')) {
       try {
         await bot.sendMessage(TARGET_GROUP_ID, `📢 <b>ประกาศจากแอดมิน:</b>\n\n${msg.text}`, { parse_mode: 'HTML' });
         // ส่งรายงานประกาศลง Channel Log ด้วยเพื่อเป็นหลักฐาน
         await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ SYSTEM LOG - ANNOUNCEMENT ]</b>\nแอดมินส่งประกาศลงกลุ่ม:\n\n${msg.text}`, { parse_mode: 'HTML' });
         bot.sendMessage(msg.chat.id, '✅ ส่งข้อความประกาศลงกลุ่มหลักเรียบร้อยครับ');
       } catch (e) {
         bot.sendMessage(msg.chat.id, `❌ ส่งประกาศไม่สำเร็จ:\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
       }
       return;
     }
  }

  // (ตัวสำรอง) เผื่อคุณยังชินกับการพิมพ์ /ban ตรงๆ แบบเดิมก็ยังใช้งานได้ครับ
  if (msg.text.startsWith('/ban ') || msg.text.startsWith('/unban ')) {
    const args = msg.text.split(' ');
    const command = args[0];
    const targetUserId = args[1];
    const reason = args.slice(2).join(' ') || 'ไม่ระบุสาเหตุ';
    if (command === '/ban') await executeBan(targetUserId, reason, msg.chat.id);
    else if (command === '/unban') await executeUnban(targetUserId, reason, msg.chat.id);
  }
});

// เปิดพอร์ตให้ Render ตรวจสอบว่าบอทไม่ตาย
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);
