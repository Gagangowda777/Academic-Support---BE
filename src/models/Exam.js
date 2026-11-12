const mongoose = require('mongoose');

const EXAM_TYPES = ['internal', 'mid_semester', 'end_semester', 'practical', 'quiz', 'other'];
const EXAM_STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'];

const examSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'An exam name is required'],
      trim: true,
      maxlength: 160,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: { values: EXAM_TYPES, message: 'Invalid exam type' },
      default: 'internal',
    },
    date: {
      type: Date,
      required: [true, 'An exam date is required'],
    },
    startTime: {
      type: String,
      required: [true, 'A start time is required'],
      trim: true,
    },
    endTime: {
      type: String,
      required: [true, 'An end time is required'],
      trim: true,
    },
    room: {
      type: String,
      trim: true,
      default: null,
    },
    maxMarks: {
      type: Number,
      required: [true, 'Maximum marks are required'],
      min: [1, 'Maximum marks must be at least 1'],
      max: [1000, 'Maximum marks cannot exceed 1000'],
    },
    passMarks: {
      type: Number,
      required: [true, 'Passing marks are required'],
      min: [0, 'Passing marks cannot be negative'],
    },
    status: {
      type: String,
      enum: { values: EXAM_STATUSES, message: 'Invalid exam status' },
      default: 'scheduled',
    },
    notes: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000,
    },
    approvedPaper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

examSchema.index({ subject: 1, date: 1 });

module.exports = mongoose.model('Exam', examSchema);
module.exports.EXAM_TYPES = EXAM_TYPES;
module.exports.EXAM_STATUSES = EXAM_STATUSES;
