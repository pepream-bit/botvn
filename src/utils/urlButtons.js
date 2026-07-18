// Parses lines like:
//   เว็บไซต์ - https://example.com
//   ปุ่ม1 - https://a.com && ปุ่ม2 - https://b.com     (multiple buttons, one row)
//   ชื่อปุ่ม - popup: ข้อความที่จะแสดง                    (popup instead of a link)
// One line = one row. "&&" on a line puts multiple buttons on that same row.
function parseUrlButtonLines(input) {
  const lines = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const buttons = [];

  for (let rowIndex = 0; rowIndex < lines.length; rowIndex++) {
    const defs = lines[rowIndex]
      .split('&&')
      .map((d) => d.trim())
      .filter(Boolean);

    for (const def of defs) {
      const popupMatch = /^(.*?)\s-\s*popup\s*:\s*(.+)$/i.exec(def);
      if (popupMatch) {
        const text = popupMatch[1].trim();
        const popupText = popupMatch[2].trim();
        if (!text || !popupText) {
          return { error: `รูปแบบปุ่ม popup ไม่ถูกต้อง: "${def}"\n(ต้องเป็น ชื่อปุ่ม - popup: ข้อความ)` };
        }
        buttons.push({ row: rowIndex, text, url: null, popupText });
        continue;
      }

      const idx = def.indexOf(' - ');
      if (idx === -1) {
        return {
          error: `รูปแบบไม่ถูกต้อง: "${def}"\n(ต้องมี " - " คั่นระหว่างข้อความปุ่มกับลิงก์ หรือใช้ " - popup: ข้อความ")`
        };
      }
      const text = def.slice(0, idx).trim();
      const url = def.slice(idx + 3).trim();
      if (!text) return { error: `ไม่มีข้อความปุ่มในบรรทัด: "${def}"` };
      if (!/^https?:\/\//i.test(url) && !/^tg:\/\//i.test(url)) {
        return { error: `ลิงก์ไม่ถูกต้อง: "${url}"\n(ต้องขึ้นต้นด้วย http://, https:// หรือ tg://)` };
      }
      buttons.push({ row: rowIndex, text, url, popupText: null });
    }
  }

  if (buttons.length === 0) return { error: 'ไม่พบข้อมูลปุ่มที่ถูกต้อง' };
  return { buttons };
}

// Telegram reply_markup for sendMessage/sendPhoto/etc. Groups by `row` so
// "&&" buttons land on the same line. Popup buttons use callback_data
// (handled publicly in bot.js, no whitelist needed) instead of a url.
function buildUrlButtonsMarkup(urlButtons, jobId) {
  if (!urlButtons || urlButtons.length === 0) return undefined;
  const rowMap = new Map();
  urlButtons.forEach((b, index) => {
    const rowKey = b.row ?? index;
    if (!rowMap.has(rowKey)) rowMap.set(rowKey, []);
    const button = b.popupText
      ? { text: b.text, callback_data: `popup:${jobId}:${index}` }
      : { text: b.text, url: b.url };
    rowMap.get(rowKey).push(button);
  });
  return { inline_keyboard: Array.from(rowMap.values()) };
}

module.exports = { parseUrlButtonLines, buildUrlButtonsMarkup };
