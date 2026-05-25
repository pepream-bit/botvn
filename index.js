const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 🛡️ ป้องกันระบบหลุด: ดึงการตั้งค่าจากระบบ Environment Variables ของ Render
const token = process.env.BOT_TOKEN;
const MY_USER_ID = parseInt(process.env.MY_USER_ID);
const TARGET_GROUP_ID = parseInt(process.env.TARGET_GROUP_ID);

// ตรวจสอบความปลอดภัยก่อนเริ่มรันระบบ
if (!token || !MY_USER_ID || !TARGET_GROUP_ID) {
  console.error('❌ ไม่สามารถเริ่มทำงานได้: กรุณาตั้งค่า Environment Variables ให้ครบถ้วนบน Render');
  process.exit(1);
}

// เปิดใช้งานบอทระบบ Polling (เสถียร 24 ชม. ไม่ดีเลย์)
const bot = new TelegramBot(token, { polling: true });

console.log('🤖 DARK VN BOT กำลังเริ่มทำงานในโหมดปลอดภัยสูงสุด...');

// 🛡️ ดักจับคำสั่ง /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (senderId !== MY_USER_ID || chatId !== MY_USER_ID) return;

  const startText = 
    `🤖 <b>ระบบ DARK VN BOT ออนไลน์แล้ว! [Render-Secure]</b>\n` +
    `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
    `บอทพร้อมรับคำสั่งจากคุณคนเดียวเรียบร้อยครับ\n\n` +
    `📌 <b>คำสั่งใช้งานที่มี:</b>\n` +
    `• <code>/ban [ไอดี] [เหตุผล]</code> - สำหรับสั่งแบน (เตะออกกลุ่ม)\n` +
    `• <code>/unban [ไอดี] [เหตุผล]</code> - สำหรับปลดแบน\n` +
    `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
    `✨ <i>ระบบทำงานในโหมดปิดความลับ ปลอดภัย 100%</i>`;

  bot.sendMessage(chatId, startText, { parse_mode: 'HTML' });
});

// 📩 ดักจับคำสั่ง /ban และ /unban
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  const text = msg.text || '';

  if (senderId !== MY_USER_ID || chatId !== MY_USER_ID) return;

  if (text.startsWith('/ban ') || text.startsWith('/unban ')) {
    const args = text.split(' ');
    const command = args[0];
    const targetUserId = args[1];
    const reason = args.slice(2).join(' ') || 'ไม่ระบุสาเหตุ';

    if (!targetUserId || isNaN(targetUserId)) {
      bot.sendMessage(MY_USER_ID, '❌ <b>รูปแบบคำสั่งไม่ถูกต้อง</b>\nกรุณาพิมพ์: <code>/ban ไอดี เหตุผล</code>', { parse_mode: 'HTML' });
      return;
    }

    if (command === '/ban') {
      try {
        await bot.banChatMember(TARGET_GROUP_ID, targetUserId);
        sendCoolStyleMessage('BAN', targetUserId, reason);
      } catch (err) {
        bot.sendMessage(MY_USER_ID, `❌ <b>เกิดข้อผิดพลาดในการแบน:</b>\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
      }
    } else if (command === '/unban') {
      try {
        await bot.unbanChatMember(TARGET_GROUP_ID, targetUserId, { only_if_banned: true });
        sendCoolStyleMessage('UNBAN', targetUserId, reason);
      } catch (err) {
        bot.sendMessage(MY_USER_ID, `❌ <b>เกิดข้อผิดพลาดในการปลดแบน:</b>\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
      }
    }
  }
});

// 🎨 ฟังก์ชันส่งประกาศเข้ากลุ่ม และตั้งเวลาทำลายตัวเองใน 1 นาที
async function sendCoolStyleMessage(action, userId, reason) {
  const isBan = action === 'BAN';
  const statusEmoji = isBan ? '🔴' : '🟢';
  const actionTitle = isBan ? '⛔ BANNED & RESTRICTED' : '🔓 ACCESS RE-GRANTED';
  const actionText = isBan ? 'ถูกจำกัดสิทธิ์และเตะออกจากกลุ่ม' : 'ถูกปลดรายชื่อออกจากบัญชีดำแล้ว';
  
  const template = 
    `<b>${statusEmoji} SYSTEM COMMAND EXECUTED</b>\n` +
    `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n\n` +
    `⚡ <b>Action:</b> <code>${actionTitle}</code>\n` +
    `👤 <b>Target ID:</b> <code>${userId}</code>\n` +
    `📝 <b>Reason:</b> <i>${reason}</i>\n\n` +
    `▫️▫️▫️▫️▫️▫️▫️▫️▫️\n` +
    `✨ <i>Status: ผู้ใช้งาน${actionText}</i>\n` +
    `⏳ <i>(ข้อความประกาศนี้จะทำลายตัวเองใน 1 นาที)</i>`;

  try {
    const groupMsg = await bot.sendMessage(TARGET_GROUP_ID, template, { parse_mode: 'HTML' });

    const briefAdminText = `✅ <b>ทำรายการ ${action} สำเร็จ!</b>\n👤 Target ID: <code>${userId}</code>`;
    bot.sendMessage(MY_USER_ID, briefAdminText, { parse_mode: 'HTML' });

    setTimeout(async () => {
      try {
        await bot.deleteMessage(TARGET_GROUP_ID, groupMsg.message_id);
        console.log(`🗑️ ลบข้อความประกาศในกลุ่มเรียบร้อย`);
      } catch (e) {
        console.error('ไม่สามารถลบข้อความได้ อาจมีคนลบไปก่อนแล้ว:', e.message);
      }
    }, 60 * 1000);

  } catch (err) {
    console.error('เกิดข้อผิดพลาดในระบบส่งข้อความ:', err.message);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🤖 DARK VN BOT [Secure Mode] ออนไลน์ปกติ 100%');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌍 เว็บเซิร์ฟเวอร์สแตนด์บายความปลอดภัยที่พอร์ต ${PORT}`);
});