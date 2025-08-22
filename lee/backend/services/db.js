// backend/services/db.js
const mongoose = require('mongoose');

/** Mongo 연결을 1회만 수행 */
let connPromise = null;
async function connectMongo() {
  if (!connPromise) {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/jobverse';
    connPromise = mongoose.connect(uri, { maxPoolSize: 10, autoIndex: true });
  }
  return connPromise;
}

/** 모델은 /models에서만 정의하고 여기서는 불러오기만 */
const Session = require('../models/session');
const Message = require('../models/message');
const Report  = require('../models/report');

/** 유틸이 필요하면 여기서만 추가(모델 재정의 금지) */
function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
}

module.exports = {
  mongoose,
  connectMongo,
  Session,
  Message,
  Report,
  toObjectId,
};
