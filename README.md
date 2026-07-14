# Telegram Broadcast Bot

บอทส่งข้อความซ้ำอัตโนมัติแบบตั้งเวลาได้ต่อกลุ่ม (คล้าย GroupHelp) — ตั้งค่า Text / Media / Url Buttons แยกเป็นชิ้นๆ, กำหนดความถี่+เวลาเริ่มส่งเอง, ปักหมุด+แจ้งเตือนเปิดปิด, ลบข้อความอัตโนมัติได้ ทั้งหมดผ่านปุ่ม inline และพิมพ์เวลาแบบสั้นๆ (เช่น `10m`, `2h`)

## ฟีเจอร์
- `/start` (แชทส่วนตัว, whitelist เท่านั้น) → รายชื่อกลุ่ม → กดเข้าไปตั้งค่า
- **ข้อความซ้ำแบบ builder** ต่อรายการ: ตั้ง Text / Media (รูป-วิดีโอ-ไฟล์) / Url Buttons แยกกัน แต่ละอันมีสถานะ ✅/❌ และปุ่ม "ดู" เพื่อพรีวิว รวมถึงปุ่ม "Full preview" ดูข้อความจริงก่อนเปิดใช้งาน
- **ตั้งความถี่ + เวลาเริ่มส่งเอง** — พิมพ์ความถี่แบบสั้น (`30s`, `15m`, `2h`, `1h30m`) แล้วพิมพ์เวลาที่จะเริ่มส่งครั้งแรก (`09:00`) หรือพิมพ์ `now` เพื่อเริ่มทันที
- ปักหมุดอัตโนมัติ พร้อมเปิด/ปิดการแจ้งเตือนตอนปักหมุดแยกต่างหาก
- **ลบข้อความ broadcast อัตโนมัติ** หลังส่ง/ปักหมุด — ตั้งเวลาแบบพิมพ์เอง (`10m`, `1h`) หรือปิด
- **ลบข้อความอื่นๆของบอทในกลุ่ม** (ที่ไม่ใช่ broadcast เช่น ข้อความยืนยัน `/register`) — ลบด้วยมือทันที หรือ**ตั้งเวลาลบอัตโนมัติ**ต่อกลุ่มก็ได้ (พิมพ์เวลาแบบเดียวกัน)
- ลบกลุ่มออกจากระบบได้ (ไม่กระทบการที่บอทอยู่ในกลุ่มเทเลแกรมจริง)
- คนอื่นที่ไม่อยู่ใน whitelist สั่ง `/start` หรือ `/register` แล้วบอทจะเงียบ ไม่ตอบกลับ ประหยัด API call
- เก็บสถานะทั้งหมดใน MongoDB — รีสตาร์ทแล้วงานที่ตั้งไว้ทำงานต่อทันที (ไม่มี state ที่หายไปเมื่อ Render restart)

## รูปแบบเวลาที่พิมพ์ได้ (ใช้ทุกจุดที่ต้องตั้งเวลา)
| พิมพ์ | ความหมาย |
|---|---|
| `30s` | 30 วินาที |
| `15m` | 15 นาที |
| `2h` | 2 ชั่วโมง |
| `1h30m` | 1 ชั่วโมง 30 นาที |
| `ปิด` หรือ `off` | ปิดฟีเจอร์นั้น (เฉพาะจุดที่ปิดได้ เช่น ลบอัตโนมัติ) |

เวลาเริ่มส่ง (`job:schedule`) พิมพ์เป็นเวลา 24 ชม. เช่น `09:00`, `21:30` หรือพิมพ์ `now` เพื่อเริ่มส่งรอบแรกทันที

## โครงสร้างโปรเจกต์
```
src/
  index.js          entry point (connect DB, launch bot, start engine, health server)
  bot.js            handlers + เมนู inline ทั้งหมด (content builder, schedule wizard)
  scheduler.js       tick engine ทุก 15 วิ — ส่งข้อความตาม nextRunAt + sweep ลบข้อความที่ถึงเวลา
  db.js              mongoose connection
  state.js           wizard state ชั่วคราวต่อผู้ใช้ (พิมพ์ text/media/เวลา ทีละขั้น)
  models/Group.js
  models/Job.js
  models/BotMessage.js       log ข้อความที่บอทส่งในกลุ่ม (ไม่ใช่ broadcast) ไว้ลบทีหลัง
  models/PendingDeletion.js  คิวลบข้อความที่ตั้งเวลาไว้ (เก็บใน Mongo ไม่ใช่ setTimeout)
  middleware/whitelist.js
  utils/duration.js     parse "10m" / "2h" -> วินาที
  utils/timeOfDay.js    parse "09:00" -> {hour, minute}
  utils/schedule.js     คำนวณเวลาส่งครั้งถัดไป (Asia/Bangkok)
  utils/urlButtons.js   parse ปุ่ม + สร้าง inline keyboard สำหรับ broadcast
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

> Free plan ของ Render จะ sleep เมื่อไม่มี request เข้ามาที่ HTTP port — ถ้าต้องการให้ระบบตั้งเวลาทำงานต่อเนื่อง 24 ชม. แนะนำ plan แบบ paid หรือ background worker, หรือ ping endpoint `/` เป็นระยะด้วยบริการ uptime monitor ภายนอก

## วิธีเพิ่มกลุ่มเข้าระบบ
1. เพิ่มบอทเข้ากลุ่ม แล้วตั้งเป็นแอดมิน (ต้องมีสิทธิ์ pin message)
2. บอทจะลงทะเบียนกลุ่มอัตโนมัติ (ผ่าน event `my_chat_member`)
   หรือถ้าเพิ่มบอทไว้ก่อนหน้านี้แล้ว ให้พิมพ์ `/register` ในกลุ่มนั้น (whitelist เท่านั้น)
3. ไปที่แชทส่วนตัวกับบอท พิมพ์ `/start` แล้วเลือกกลุ่มที่ต้องการตั้งค่า

## วิธีสร้างข้อความซ้ำ
1. เลือกกลุ่ม → ➕ เพิ่มข้อความใหม่ (สร้าง "ข้อความซ้ำ" ว่างๆ ขึ้นมาก่อน)
2. กด 📄 Text เพื่อพิมพ์ข้อความ / 🖼 Media เพื่อส่งรูป-วิดีโอ-ไฟล์ / 🔗 Url Buttons เพื่อเพิ่มปุ่มลิงก์ (ตั้งอย่างน้อย Text หรือ Media อย่างใดอย่างหนึ่ง)
3. กด 👀 Full preview เพื่อดูข้อความจริงก่อนใช้งานจริง
4. กด ⏱ ตั้งความถี่ & เวลาเริ่ม → พิมพ์ความถี่ (เช่น `1h`) → พิมพ์เวลาเริ่ม (เช่น `09:00` หรือ `now`)
5. กด ▶️ เปิดใช้งาน — บอทจะเริ่มส่งตามตารางที่ตั้งไว้

