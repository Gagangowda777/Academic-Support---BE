const mongoose = require('mongoose');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const COGNITIVE_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const PAPER_STATUSES = ['submitted', 'approved', 'rejected'];

const questionSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: [true, 'Question text is required'],
      trim: true,
      maxlength: 1000,
    },
    unit: {
      type: String,
      required: [true, 'A syllabus unit is required'],
      trim: true,
      maxlength: 160,
    },
    marks: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    difficulty: {
      type: String,
      enum: { values: DIFFICULTIES, message: 'Invalid difficulty' },
      required: true,
    },
    cognitive: {
      type: String,
      enum: { values: COGNITIVE_LEVELS, message: 'Invalid cognitive level' },
      required: true,
    },
    answerKey: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },
  },
  { _id: false }
);

const breakdownSchema = new mongoose.Schema(
  {
    key: String,
    label: String,
    weight: Number,
    score: Number,
    earned: Number,
  },
  { _id: false }
);

const EVALUATION_STATUSES = [
  'not_started',
  'queued',
  'processing',
  'completed',
  'failed',
];

const paperDocumentSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true, trim: true },
    storedName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedAt: { type: Date, default: Date.now },
    extractedText: { type: String, default: '', select: false },
  },
  { _id: false }
);

const evaluationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: EVALUATION_STATUSES,
      default: 'not_started',
    },
    error: { type: String, default: '', maxlength: 500 },
    total: { type: Number, default: 0 },
    breakdown: { type: [breakdownSchema], default: [] },
    summary: { type: String, default: '' },
    strengths: { type: [String], default: [] },
    risks: { type: [String], default: [] },
    engine: { type: String, default: '' },
    evaluatedAt: { type: Date, default: null },
  },
  { _id: false }
);

// One paper set submitted by one faculty member for one exam. The Examination
// Cell approves at most one of these per exam.
const questionPaperSchema = new mongoose.Schema(
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
    title: {
      type: String,
      required: [true, 'A paper title is required'],
      trim: true,
      maxlength: 120,
    },
    submissionType: {
      type: String,
      enum: ['structured', 'document'],
      default: 'structured',
    },
    questions: {
      type: [questionSchema],
      default: [],
    },
    // The original paper and optional answer key uploaded as files. These are
    // served through an authenticated route, never from public static storage.
    paperDocument: {
      type: paperDocumentSchema,
      default: null,
    },
    answerKeyDocument: {
      type: paperDocumentSchema,
      default: null,
    },
    totalMarks: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: { values: PAPER_STATUSES, message: 'Invalid paper status' },
      default: 'submitted',
      index: true,
    },
    evaluation: {
      type: evaluationSchema,
      default: () => ({}),
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewNote: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },
  },
  { timestamps: true }
);

questionPaperSchema.index({ exam: 1, faculty: 1, title: 1 }, { unique: true });
questionPaperSchema.index({ exam: 1, status: 1 });

module.exports = mongoose.model('QuestionPaper', questionPaperSchema);
module.exports.DIFFICULTIES = DIFFICULTIES;
module.exports.COGNITIVE_LEVELS = COGNITIVE_LEVELS;
module.exports.PAPER_STATUSES = PAPER_STATUSES;
module.exports.SUBMISSION_TYPES = ['structured', 'document'];
module.exports.EVALUATION_STATUSES = EVALUATION_STATUSES;
