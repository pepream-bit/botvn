const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

// Returns a Date whose UTC getters read as Bangkok wall-clock fields.
function nowInBangkokFields() {
  return new Date(Date.now() + BANGKOK_OFFSET_MS);
}

// First run after (re)scheduling: anchor to today's startHour:startMinute
// in Bangkok time, then roll forward by intervalSeconds until it's in the future.
function computeInitialNextRun(startHour, startMinute, intervalSeconds) {
  const bkkNow = nowInBangkokFields();
  let anchorBkk = new Date(
    Date.UTC(bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate(), startHour, startMinute, 0, 0)
  );
  const intervalMs = Math.max(intervalSeconds, 1) * 1000;
  while (anchorBkk.getTime() <= bkkNow.getTime()) {
    anchorBkk = new Date(anchorBkk.getTime() + intervalMs);
  }
  return new Date(anchorBkk.getTime() - BANGKOK_OFFSET_MS);
}

// After each actual send: step forward by intervalSeconds from the previous
// run time. If the bot was down and missed slots, skip ahead to the next
// future slot instead of bursting out all the missed sends at once.
function advanceNextRun(prevNextRunAt, intervalSeconds) {
  const intervalMs = Math.max(intervalSeconds, 1) * 1000;
  let next = new Date(prevNextRunAt.getTime() + intervalMs);
  const now = Date.now();
  while (next.getTime() <= now) {
    next = new Date(next.getTime() + intervalMs);
  }
  return next;
}

module.exports = { computeInitialNextRun, advanceNextRun };
