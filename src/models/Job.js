const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },
  text: { type: String, required: true },
  cron: { type: String, required: true },
  intervalLabel: { type: String, default: '' },
  pin: { type: Boolean, default: false },
  pinNotify: { type: Boolean, default: true }, // true = notify on pin, false = silent pin
  enabled: { type: Boolean, default: true },
  autoDeleteMinutes: { type: Number, default: 0 }, // 0 = never auto-delete
  lastMessageId: { type: Number, default: null },
  createdBy: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Job', jobSchema);
