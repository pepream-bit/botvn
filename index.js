const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ดึงค่าตัวแปรลับจาก Render
const token = process.env.BOT_TOKEN;
const MY_USER_ID = parseInt(process.env.MY_USER_ID);
const TARGET_GROUP_ID = parseInt(process.env.TARGET_GROUP_ID);
const LOG_CHANNEL_ID = parseInt(process.env.LOG_CHANNEL_ID);

if (!token || !MY_USER_ID || !TARGET_GROUP_ID || !LOG_CHANNEL_ID) {
  console.error('❌ ข้อมูล Environment Variables ไม่ครบถ้วน กรุณาตรวจสอบบน Render');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log('🛸 Alian Attack Bot เริ่มทำงาน (ปิดระบบ /ban แบบข้อความเพื่อหลบ GroupHelp)...');

// ==========================================
// ฟังก์ชันจัดการ การแบน (ธีม Alian Attack)
// ==========================================
async function executeBan(targetUserId, reason, chatId) {
  if (!targetUserId || isNaN(targetUserId)) {
    return bot.sendMessage(chatId, '❌ ข้อมูลผิดพลาด: กรุณาระบุเป็นตัวเลขไอดีเท่านั้น', { parse_mode: 'HTML' });
  }
  const timeStamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  
  try {
    await bot.banChatMember(TARGET_GROUP_ID, targetUserId);
    
    // ประกาศในกลุ่ม (ลบทิ้งใน 1 นาที) - ธีมยานแม่
    const m = await bot.sendMessage(TARGET_GROUP_ID, `🛸 <b>ALIEN ABDUCTION (แบนผู้ใช้)</b>\n👽 เป้าหมาย ID: <code>${targetUserId}</code> ถูกยานแม่ Alian Attack ดูดออกจากพื้นที่แล้ว!\n📝 ข้อหา: ${reason}`, { parse_mode: 'HTML' });
    setTimeout(() => bot.deleteMessage(TARGET_GROUP_ID, m.message_id).catch(() => {}), 60000);
    
    // ส่ง Log ถาวร
    await bot.sendMessage(LOG_CHANNEL_ID, 
      `📜 <b>[ SYSTEM LOG - BAN ]</b>\n` +
      `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
      `🔴 <b>การกระทำ:</b> สั่งแบนผู้ใช้งาน (Alian Attack)\n` +
      `👤 <b>เป้าหมาย ID:</b> <code>${targetUserId}</code>\n` +
      `📝 <b>เหตุผล:</b> <i>${reason}</i>\n` +
      `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
      `⏰ <b>เวลา:</b> ${timeStamp} น.`, 
      { parse_mode: 'HTML' }
    );

    bot.sendMessage(chatId, `✅ ยานแม่จับกุมสำเร็จและส่ง Log เรียบร้อย: <code>${targetUserId}</code>`, { parse_mode: 'HTML' });
  } catch (e) { 
    // กรณีที่คนนั้นโดนแบนไปแล้ว หรือบอทไม่มีสิทธิ์
    bot.sendMessage(chatId, `⚠️ <b>เป้าหมายนี้ถูกกำจัดไปแล้ว!</b> 🛸\n(เป้าหมายอาจจะโดนแบนไปก่อนหน้าแล้ว หรือยานแม่ไม่มีสิทธิ์แบนคนนี้)\n\n<code>รายละเอียดระบบ: ${e.message}</code>`, { parse_mode: 'HTML' }); 
  }
}

// ==========================================
// ฟังก์ชันจัดการ การปลดแบน (ธีม Alian Attack)
// ==========================================
async function executeUnban(targetUserId, reason, chatId) {
  if (!targetUserId || isNaN(targetUserId)) {
    return bot.sendMessage(chatId, '❌ ข้อมูลผิดพลาด: กรุณาระบุเป็นตัวเลขไอดีเท่านั้น', { parse_mode: 'HTML' });
  }
  const timeStamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  
  try {
    await bot.unbanChatMember(TARGET_GROUP_ID, targetUserId, { only_if_banned: true });
    
    // ประกาศในกลุ่ม (ลบทิ้งใน 1 นาที)
    const m = await bot.sendMessage(TARGET_GROUP_ID, `🛸 <b>TARGET RELEASED (ปลดแบน)</b>\n👽 เป้าหมาย ID: <code>${targetUserId}</code> ได้รับการปล่อยตัวจากยานแม่!\n📝 เหตุผล: ${reason}`, { parse_mode: 'HTML' });
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
    bot.sendMessage(chatId, `⚠️ <b>ไม่สามารถปล่อยตัวได้!</b>\n(อาจจะไม่ได้โดนแบนอยู่ หรือมีข้อผิดพลาดระบบ)\n\n<code>รายละเอียดระบบ: ${e.message}</code>`, { parse_mode: 'HTML' }); 
  }
}

// ==========================================
// 1. ส่งหน้าต่างปุ่มกดเมื่อพิมพ์ /start
// ==========================================
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== MY_USER_ID) return;
  
  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🛸 จับกุม (Ban)', callback_data: 'cmd_ban' },
          { text: '🟢 ปล่อยตัว (Unban)', callback_data: 'cmd_unban' }
        ],
        [
          { text: '📢 ประกาศคำสั่งยานแม่', callback_data: 'cmd_announce' }
        ]
      ]
    }
  };
  
  bot.sendMessage(msg.chat.id, "🛸 <b>ยานแม่ Alian Attack ออนไลน์!</b>\nกรุณากดเลือกเมนูควบคุมยานแม่ด้านล่างนี้:", options);
});

// ==========================================
// 2. จัดการคำสั่งเมื่อคุณกดปุ่มบนจอ
// ==========================================
bot.on('callback_query', (query) => {
  if (query.from.id !== MY_USER_ID) return bot.answerCallbackQuery(query.id, { text: 'คุณไม่มีสิทธิ์ควบคุมยานแม่!', show_alert: true });
  
  const chatId = query.message.chat.id;
  
  if (query.data === 'cmd_ban') {
    bot.sendMessage(chatId, '🛸 <b>โหมดจับกุม (แบน)</b>\nกรุณาพิมพ์:\n<code>ไอดี เหตุผล</code>\n(เช่น 123456789 สแปมกลุ่ม)', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
  } else if (query.data === 'cmd_unban') {
    bot.sendMessage(chatId, '🟢 <b>โหมดปล่อยตัว (ปลดแบน)</b>\nกรุณาพิมพ์:\n<code>ไอดี เหตุผล</code>\n(เช่น 123456789 ขอโอกาส)', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
  } else if (query.data === 'cmd_announce') {
    bot.sendMessage(chatId, '📢 <b>โหมดประกาศ</b>\nพิมพ์ข้อความที่ต้องการให้ยานแม่ประกาศลงกลุ่ม:', {
      parse_mode: 'HTML', reply_markup: { force_reply: true }
    });
  }
  
  bot.answerCallbackQuery(query.id);
});

// ==========================================
// 3. ดักจับข้อความ (รับเฉพาะตอนคุณ Reply ตอบบอทเท่านั้น)
// ==========================================
bot.on('message', async (msg) => {
  if (msg.from.id !== MY_USER_ID) return;
  if (!msg.text) return;
  if (msg.text.startsWith('/start')) return;

  // ตรวจสอบว่าคุณพิมพ์ตอบกลับ (Reply) จากช่องที่เด้งขึ้นมาหรือไม่
  if (msg.reply_to_message && msg.reply_to_message.text) {
     const promptText = msg.reply_to_message.text;
     
     if (promptText.includes('โหมดจับกุม (แบน)')) {
       const args = msg.text.split(' ');
       const targetUserId = args[0];
       const reason = args.slice(1).join(' ') || 'คำสั่งจากยานแม่';
       await executeBan(targetUserId, reason, msg.chat.id);
       return;
     }
     
     if (promptText.includes('โหมดปล่อยตัว (ปลดแบน)')) {
       const args = msg.text.split(' ');
       const targetUserId = args[0];
       const reason = args.slice(1).join(' ') || 'ความเมตตาจากยานแม่';
       await executeUnban(targetUserId, reason, msg.chat.id);
       return;
     }
     
     if (promptText.includes('โหมดประกาศ')) {
       try {
         await bot.sendMessage(TARGET_GROUP_ID, `📢 <b>ประกาศจากยานแม่ Alian Attack:</b>\n\n${msg.text}`, { parse_mode: 'HTML' });
         await bot.sendMessage(LOG_CHANNEL_ID, `📜 <b>[ SYSTEM LOG - ANNOUNCEMENT ]</b>\nยานแม่ส่งประกาศลงกลุ่ม:\n\n${msg.text}`, { parse_mode: 'HTML' });
         bot.sendMessage(msg.chat.id, '✅ ส่งข้อความประกาศลงกลุ่มหลักเรียบร้อยครับ');
       } catch (e) {
         bot.sendMessage(msg.chat.id, `❌ ส่งประกาศไม่สำเร็จ:\n<code>${e.message}</code>`, { parse_mode: 'HTML' });
       }
       return;
     }
  }
  
  // ⛔ โค้ดเดิมที่รับคำสั่ง /ban หรือ /unban ตรงๆ ถูกลบทิ้งหมดแล้ว
  // ทำให้บอทตัวนี้จะไม่ทำงานทับซ้อนกับ GroupHelp แน่นอนครับ!
});

// เปิดพอร์ตให้ Render ตรวจสอบว่าบอทไม่ตาย
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);
