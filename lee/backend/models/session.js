const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  userId: String,                 // 표시용 이름 or 사용자 ID
  jobRole: String,                // 지원 직무
  interviewers: [String],         // ['A','B','C']
  startedAt: Date,
  endedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('Session', SessionSchema);
