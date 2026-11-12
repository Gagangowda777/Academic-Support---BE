const mongoose = require('mongoose');

const ANALYSIS_JOB_TYPES = ['notes_bank', 'past_papers'];
const ANALYSIS_JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'];

const analysisJobSchema = new mongoose.Schema(
  {
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: true,
      index: true,
    },
    faculty: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ANALYSIS_JOB_TYPES,
      required: true,
    },
    status: {
      type: String,
      enum: ANALYSIS_JOB_STATUSES,
      default: 'queued',
      index: true,
    },
    // Set only while queued or processing. Its unique index prevents two active
    // runs of the same analysis for one faculty member and examination.
    activeKey: { type: String },
    attachmentIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
    ],
    paperIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'PastQuestionPaper' },
    ],
    error: { type: String, default: '', maxlength: 1000 },
    message: { type: String, default: '', maxlength: 1000 },
    warnings: { type: [String], default: [] },
    resultBank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionBank',
      default: null,
    },
    resultAnalysis: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PastPaperAnalysis',
      default: null,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

analysisJobSchema.index(
  { activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: { $type: 'string' } },
  }
);
analysisJobSchema.index({ exam: 1, faculty: 1, createdAt: -1 });

module.exports = mongoose.model('AnalysisJob', analysisJobSchema);
module.exports.ANALYSIS_JOB_TYPES = ANALYSIS_JOB_TYPES;
module.exports.ANALYSIS_JOB_STATUSES = ANALYSIS_JOB_STATUSES;
