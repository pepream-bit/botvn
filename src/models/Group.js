const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  title: { type: String, default: 'Unknown Group' },
  type: { type: String, default: 'group' },
  pinNotifyDefault: { type: Boolean, default: true }, // default used for new jobs
  autoCleanupSeconds: { type: Number, default: 0 }, // 0 = off; else auto-delete bot's own non-broadcast messages after this many seconds
  addedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Group', groupSchema);
