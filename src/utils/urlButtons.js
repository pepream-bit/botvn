// Parses lines like:
//   เว็บไซต์ - https://example.com
//   ติดต่อแอดมิน - https://t.me/xxx
// One button per line, "text - url" separated by " - ".
function parseUrlButtonLines(input) {
  const lines = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const buttons = [];
  for (const line of lines) {
    const idx = line.indexOf(' - ');
    if (idx === -1) {
      return { error: `รูปแบบไม่ถูกต้อง: "${line}"\n(ต้องมี " - " คั่นระหว่างข้อความปุ่มกับลิงก์)` };
    }
    const text = line.slice(0, idx).trim();
    const url = line.slice(idx + 3).trim();
    if (!text) return { error: `ไม่มีข้อความปุ่มในบรรทัด: "${line}"` };
    if (!/^https?:\/\//i.test(url) && !/^tg:\/\//i.test(url)) {
      return { error: `ลิงก์ไม่ถูกต้อง: "${url}"\n(ต้องขึ้นต้นด้วย http://, https:// หรือ tg://)` };
    }
    buttons.push({ text, url });
  }
  if (buttons.length === 0) return { error: 'ไม่พบข้อมูลปุ่มที่ถูกต้อง' };
  return { buttons };
}

// Telegram reply_markup for sendMessage/sendPhoto/etc. One button per row.
function buildUrlButtonsMarkup(urlButtons) {
  if (!urlButtons || urlButtons.length === 0) return undefined;
  return { inline_keyboard: urlButtons.map((b) => [{ text: b.text, url: b.url }]) };
}

module.exports = { parseUrlButtonLines, buildUrlButtonsMarkup };
