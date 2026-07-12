// preset code -> { cron, label }
const PRESETS = {
  m15: { cron: '*/15 * * * *', label: 'ทุก 15 นาที' },
  m30: { cron: '*/30 * * * *', label: 'ทุก 30 นาที' },
  h1: { cron: '0 * * * *', label: 'ทุก 1 ชั่วโมง' },
  h3: { cron: '0 */3 * * *', label: 'ทุก 3 ชั่วโมง' },
  h6: { cron: '0 */6 * * *', label: 'ทุก 6 ชั่วโมง' },
  h12: { cron: '0 */12 * * *', label: 'ทุก 12 ชั่วโมง' },
  d1: { cron: '0 9 * * *', label: 'ทุกวัน เวลา 09:00' }
};

// preset code -> { minutes, label } — used for "auto-delete after send/pin"
const AUTO_DELETE_PRESETS = {
  off: { minutes: 0, label: 'ปิด (ไม่ลบอัตโนมัติ)' },
  m10: { minutes: 10, label: 'ลบหลัง 10 นาที' },
  m30: { minutes: 30, label: 'ลบหลัง 30 นาที' },
  h1: { minutes: 60, label: 'ลบหลัง 1 ชั่วโมง' },
  h3: { minutes: 180, label: 'ลบหลัง 3 ชั่วโมง' },
  h6: { minutes: 360, label: 'ลบหลัง 6 ชั่วโมง' },
  h12: { minutes: 720, label: 'ลบหลัง 12 ชั่วโมง' },
  h24: { minutes: 1440, label: 'ลบหลัง 24 ชั่วโมง' }
};

module.exports = { PRESETS, AUTO_DELETE_PRESETS };
