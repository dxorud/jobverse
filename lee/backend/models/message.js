const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', index: true },
  role: { type: String, enum: ['interviewer', 'candidate'] },
  interviewer: String,            // 'A' | 'B' | 'C' (interviewer일 때)
  round: Number,                  // 1..N
  text: String,
}, { timestamps: true });

module.exports = mongoose.model('Message', MessageSchema);
