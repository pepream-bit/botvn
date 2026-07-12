# Telegram Broadcast Bot

บอทส่งข้อความซ้ำอัตโนมัติแบบตั้งเวลาได้ต่อกลุ่ม (คล้าย GroupHelp) — ปรับข้อความ, ความถี่, ปักหมุด+เปิด/ปิดแจ้งเตือน ผ่านปุ่ม inline ทั้งหมด

## ฟีเจอร์
- `/start` (แชทส่วนตัว, whitelist เท่านั้น) → แสดงรายชื่อกลุ่มที่บอทอยู่ → กดเข้าไปตั้งค่าแต่ละกลุ่ม
- เพิ่ม/แก้ไข/ลบ/เปิดปิด ข้อความซ้ำต่อกลุ่ม ไม่จำกัดจำนวน
- เลือกความถี่จาก preset (15นาที/30นาที/1ชม./3ชม./6ชม./12ชม./รายวัน) หรือกำหนดเอง (custom cron)
- ปักหมุดข้อความอัตโนมัติ พร้อมเปิด/ปิดการแจ้งเตือนตอนปักหมุดแยกต่างหาก
- เก็บสถานะทั้งหมดใน MongoDB — รีสตาร์ทแล้วงานที่ตั้งไว้ทำงานต่อทันที

## โครงสร้างโปรเจกต์
```
src/
  index.js          entry point (connect DB, launch bot, health server)
  bot.js            handlers + inline menu ทั้งหมด
  scheduler.js       node-cron job management
  db.js              mongoose connection
  state.js           wizard state ชั่วคราวต่อผู้ใช้
  models/Group.js
  models/Job.js
  middleware/whitelist.js
  utils/cronPresets.js
render.yaml
.env.example
```

## Environment Variables
| ตัวแปร | คำอธิบาย |
|---|---|
| `BOT_TOKEN` | token จาก @BotFather |
| `WHITELIST_IDS` | Telegram user id ที่อนุญาตให้ตั้งค่าบอทได้ คั่นด้วย comma เช่น `111,222` |
| `MONGODB_URI` | connection string ของ MongoDB (Atlas แนะนำ) |
| `PORT` | (Render ตั้งให้อัตโนมัติ ไม่ต้องใส่เองก็ได้) |

## รันบนเครื่องตัวเอง
```bash
cp .env.example .env   # แล้วกรอกค่าจริง
npm install
npm start
```

## ขึ้น GitHub
```bash
git init
git add .
git commit -m "init: telegram broadcast bot"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```
**อย่า commit ไฟล์ `.env`** — ใส่ค่าจริงเฉพาะใน Render Environment เท่านั้น (`.gitignore` กันไว้ให้แล้ว)

## Deploy บน Render
1. New → Web Service → เชื่อม repo GitHub นี้ (Render จะอ่าน `render.yaml` ให้อัตโนมัติ)
2. Runtime: Node, Build: `npm install`, Start: `npm start`
3. ตั้งค่า Environment: `BOT_TOKEN`, `WHITELIST_IDS`, `MONGODB_URI`
4. Deploy — บอทใช้ polling (ไม่ต้องตั้ง webhook) และเปิด HTTP port ไว้ให้ Render เห็นว่า service ทำงานอยู่

> Free plan ของ Render จะ sleep เมื่อไม่มี request เข้ามาที่ HTTP port — ถ้าต้องการให้ cron ทำงานต่อเนื่อง 24 ชม. แนะนำ plan แบบ paid หรือ background worker, หรือ ping endpoint `/` เป็นระยะด้วยบริการ uptime monitor ภายนอก

## วิธีเพิ่มกลุ่มเข้าระบบ
1. เพิ่มบอทเข้ากลุ่ม แล้วตั้งเป็นแอดมิน (ต้องมีสิทธิ์ pin message)
2. บอทจะลงทะเบียนกลุ่มอัตโนมัติ (ผ่าน event `my_chat_member`)
   หรือถ้าเพิ่มบอทไว้ก่อนหน้านี้แล้ว ให้พิมพ์ `/register` ในกลุ่มนั้น (whitelist เท่านั้น)
3. ไปที่แชทส่วนตัวกับบอท พิมพ์ `/start` แล้วเลือกกลุ่มที่ต้องการตั้งค่า

## Cron expression format
มาตรฐาน 5 ช่อง: `นาที ชั่วโมง วัน เดือน วันในสัปดาห์` (timezone: Asia/Bangkok)
ตัวอย่าง: `0 */2 * * *` = ทุก 2 ชั่วโมง, `30 8 * * *` = ทุกวัน 08:30
