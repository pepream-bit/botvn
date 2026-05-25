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
console.log('🤖 DARK VN BOT เริ่มทำงาน (Secure Mode + Auto Log)...');

bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== MY_USER_ID) return;
  bot.sendMessage(msg.chat.id, "🤖 <b>ระบบ DARK VN BOT ออนไลน์!</b>\nพร้อมรับคำสั่ง แบน/ปลดแบน และบันทึก Log แล้ว", { parse_mode: 'HTML' });
});

bot.on('message', async (msg) => {
  if (msg.from.id !== MY_USER_ID) return;
  if (!msg.text || (!msg.text.startsWith('/ban ') && !msg.text.startsWith('/unban '))) return;

  const args = msg.text.split(' ');
  const command = args[0];
  const targetUserId = args[1];
  const reason = args.slice(2).join(' ') || 'ไม่ระบุสาเหตุ';

  if (!targetUserId || isNaN(targetUserId)) {
    return bot.sendMessage(MY_USER_ID, '❌ รูปแบบไม่ถูกต้อง: ใช้ <code>/ban ไอดี เหตุผล</code> หรือ <code>/unban ไอดี เหตุผล</code>', { parse_mode: 'HTML' });
  }

  const timeStamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

  if (command === '/ban') {
    try {
      await bot.banChatMember(TARGET_GROUP_ID, targetUserId);
      
      // ประกาศในกลุ่ม (ลบทิ้งใน 1 นาที)
      const m = await bot.sendMessage(TARGET_GROUP_ID, `⛔ <b>BANNED & RESTRICTED</b>\n👤 ID: <code>${targetUserId}</code>\n📝 เหตุผล: ${reason}`, { parse_mode: 'HTML' });
      setTimeout(() => bot.deleteMessage(TARGET_GROUP_ID, m.message_id).catch(() => {}), 60000);
      
      // ส่ง Log เข้า Channel (ถาวร)
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

      bot.sendMessage(MY_USER_ID, `✅ แบนและส่ง Log สำเร็จ: <code>${targetUserId}</code>`, { parse_mode: 'HTML' });
    } catch (e) { 
      bot.sendMessage(MY_USER_ID, `❌ Error:\n<code>${e.message}</code>`, { parse_mode: 'HTML' }); 
    }
    
  } else if (command === '/unban') {
    try {
      await bot.unbanChatMember(TARGET_GROUP_ID, targetUserId, { only_if_banned: true });
      
      // ประกาศในกลุ่ม (ลบทิ้งใน 1 นาที)
      const m = await bot.sendMessage(TARGET_GROUP_ID, `🟢 <b>ACCESS RE-GRANTED</b>\n👤 ID: <code>${targetUserId}</code>\n📝 ผู้ใช้งานถูกปลดแบนเรียบร้อย`, { parse_mode: 'HTML' });
      setTimeout(() => bot.deleteMessage(TARGET_GROUP_ID, m.message_id).catch(() => {}), 60000);

      // ส่ง Log เข้า Channel (ถาวร)
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

      bot.sendMessage(MY_USER_ID, `✅ ปลดแบนและส่ง Log สำเร็จ: <code>${targetUserId}</code>`, { parse_mode: 'HTML' });
    } catch (e) { 
      bot.sendMessage(MY_USER_ID, `❌ Error:\n<code>${e.message}</code>`, { parse_mode: 'HTML' }); 
    }
  }
});

// เปิดพอร์ตให้ Render ตรวจสอบว่าบอทไม่ตาย
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);
