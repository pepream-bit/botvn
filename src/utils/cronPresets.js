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

module.exports = { PRESETS };
