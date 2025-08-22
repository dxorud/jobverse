// backend/models/report.js
const mongoose = require('mongoose');

/* ===== Sub Schemas (no _id for array items) ===== */
const RoundSchema = new mongoose.Schema(
  {
    round: { type: Number, required: true },
    question: { type: String, default: '' },
    answer: { type: String, default: '' },
    pros: { type: [String], default: [] },
    cons: { type: [String], default: [] },
    score: { type: Number, min: 0, max: 100, default: null }, // 선택
  },
  { _id: false }
);

const SkillSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },   // e.g. communication
    label: { type: String, default: '' },    // e.g. 의사소통
    score: { type: Number, min: 0, max: 5, default: 0 },
  },
  { _id: false }
);

const VizSchema = new mongoose.Schema(
  {
    radar: {
      type: [{ key: String, label: String, score: Number }],
      default: [],
      _id: false,
    },
    trend: {
      type: [{ round: Number, score: Number }],
      default: [],
      _id: false,
    },
    keywords: {
      type: [{ word: String, count: Number }],
      default: [],
      _id: false,
    },
  },
  { _id: false }
);

/* ===== Main Schema ===== */
const ReportSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      index: true,
      unique: true,
      required: true,
    },

    basic: {
      name: { type: String, default: '' },
      jobRole: { type: String, default: '' },
      interviewedAt: { type: Date },
      interviewers: { type: [String], default: [] },
      rounds: { type: Number, default: 0 },
    },

    summary: {
      totalScore: { type: Number, min: 0, max: 100, default: 0 },
      passBand: {
        type: String,
        enum: ['pass-likely', 'border', 'below'],
        default: 'below',
      },
      oneLiner: { type: String, default: '' },
    },

    rounds: { type: [RoundSchema], default: [] },
    skills: { type: [SkillSchema], default: [] },
    viz: { type: VizSchema, default: () => ({}) },

    extra: {
      modelAnswerDiff: { type: String, default: '' },
      risks: { type: [String], default: [] },
      learning: { type: [String], default: [] },
    },
  },
  {
    timestamps: true,
    // collection: 'reports' // <- 필요시 명시
  }
);

/* ===== Optional text index (다국어 토크나이징은 Mongo 설정에 따름) ===== */
ReportSchema.index({
  'basic.name': 'text',
  'basic.jobRole': 'text',
  'extra.modelAnswerDiff': 'text',
  'viz.keywords.word': 'text',
});

ReportSchema.index({ createdAt: -1 });
ReportSchema.index({ 'basic.name': 1, 'basic.jobRole': 1, createdAt: -1 });

/* ===== Export with guard (prevents OverwriteModelError) ===== */
module.exports = mongoose.models.Report || mongoose.model('Report', ReportSchema);
