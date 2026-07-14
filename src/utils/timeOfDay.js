// Parses a 24h "HH:mm" string, e.g. "09:00", "9:00", "21:30".
function parseTimeOfDay(input) {
  if (!input) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function formatTimeOfDay(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

module.exports = { parseTimeOfDay, formatTimeOfDay };
