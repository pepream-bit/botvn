const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },

  // ---- content (built piece by piece, like the "recurring message" screen) ----
  text: { type: String, default: '' },
  media: {
    fileId: { type: String, default: null },
    type: { type: String, enum: ['photo', 'video', 'document', 'animation', null], default: null }
  },
  urlButtons: [{ text: String, url: String }],

  // ---- schedule: repeat every intervalSeconds, first run anchored to startHour:startMinute (Asia/Bangkok) ----
  intervalSeconds: { type: Number, default: 3600 },
  intervalLabel: { type: String, default: '1h' },
  startHour: { type: Number, default: 9 },
  startMinute: { type: Number, default: 0 },
  nextRunAt: { type: Date, default: null },

  // ---- delivery options ----
  pin: { type: Boolean, default: false },
  pinNotify: { type: Boolean, default: true }, // true = notify on pin, false = silent pin
  autoDeleteSeconds: { type: Number, default: 0 }, // 0 = never auto-delete this broadcast message

  enabled: { type: Boolean, default: false }, // stays off until content is set and admin turns it on
  lastMessageId: { type: Number, default: null },
  createdBy: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Job', jobSchema);
