function getWhitelist() {
  return (process.env.WHITELIST_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isWhitelisted(userId) {
  return getWhitelist().includes(String(userId));
}

// Telegraf middleware: blocks non-whitelisted users from private-chat config commands.
// Silent on rejection (no reply) — avoids wasting an API call / leaking bot behavior to strangers.
function whitelistOnly() {
  return (ctx, next) => {
    if (!ctx.from) return;
    if (!isWhitelisted(ctx.from.id)) return;
    return next();
  };
}

module.exports = { isWhitelisted, whitelistOnly };
