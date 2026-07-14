// Parses shorthand duration strings like "30s", "10m", "2h", "1h30m" -> total seconds.
// Returns null if the string doesn't parse cleanly.
function parseDuration(input) {
  if (!input) return null;
  const str = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!str) return null;

  const re = /(\d+(?:\.\d+)?)(s|m|h|d)/g;
  let match;
  let totalSeconds = 0;
  let consumedLength = 0;
  let matchedAny = false;

  while ((match = re.exec(str)) !== null) {
    matchedAny = true;
    const value = parseFloat(match[1]);
    const unit = match[2];
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    totalSeconds += value * mult;
    consumedLength += match[0].length;
  }

  if (!matchedAny || consumedLength !== str.length) return null;
  return Math.round(totalSeconds);
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return 'ปิด';
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = { parseDuration, formatDuration };
