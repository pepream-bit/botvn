const mongoose = require('mongoose');

const botMessageSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },
  messageId: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BotMessage', botMessageSchema);
