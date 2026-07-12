// In-memory per-user wizard state for the "add job" / "custom cron" flows.
// key: telegram user id -> { step, chatId, text, ... }
const state = new Map();

module.exports = state;
