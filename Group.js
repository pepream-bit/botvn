function getWhitelist() {
  return (process.env.WHITELIST_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isWhitelisted(userId) {
  return getWhitelist().includes(String(userId));
}

// Telegraf middleware: blocks non-whitelisted users from private-chat config commands
function whitelistOnly() {
  return (ctx, next) => {
    if (!ctx.from) return;
    if (!isWhitelisted(ctx.from.id)) {
      return ctx.reply('⛔ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้');
    }
    return next();
  };
}

module.exports = { isWhitelisted, whitelistOnly };
