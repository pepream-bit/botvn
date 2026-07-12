const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  title: { type: String, default: 'Unknown Group' },
  type: { type: String, default: 'group' },
  pinNotifyDefault: { type: Boolean, default: true }, // default used for new jobs
  addedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Group', groupSchema);
