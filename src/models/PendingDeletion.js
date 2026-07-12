const mongoose = require('mongoose');

const pendingDeletionSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },
  messageId: { type: Number, required: true },
  deleteAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('PendingDeletion', pendingDeletionSchema);
