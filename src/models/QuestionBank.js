const mongoose = require('mongoose');
const {
  DIFFICULTIES,
  COGNITIVE_LEVELS,
} = require('./QuestionPaper');

const generatedQuestionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    unit: { type: String, required: true, trim: true, maxlength: 160 },
    marks: { type: Number, required: true, min: 1, max: 100 },
    difficulty: { type: String, enum: DIFFICULTIES, required: true },
    cognitive: { type: String, enum: COGNITIVE_LEVELS, required: true },
    answerKey: { type: String, trim: true, default: '', maxlength: 2000 },
  },
  { _id: false }
);

const questionBankSchema = new mongoose.Schema(
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
    title: { type: String, required: true, trim: true, maxlength: 160 },
    questions: { type: [generatedQuestionSchema], required: true },
    analysis: {
      summary: { type: String, required: true, maxlength: 1500 },
      recurringTopics: {
        type: [
          {
            topic: { type: String, required: true, maxlength: 150 },
            unit: { type: String, required: true, maxlength: 160 },
            frequency: { type: Number, required: true, min: 1, max: 5 },
            years: [{ type: Number }],
            _id: false,
          },
        ],
        default: [],
      },
      patterns: { type: [String], default: [] },
      recommendations: { type: [String], default: [] },
      coverageGaps: { type: [String], default: [] },
    },
    sources: {
      notes: {
        type: [
          {
            attachmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
            name: { type: String, required: true },
            sessionTopic: { type: String, default: '' },
            _id: false,
          },
        ],
        default: [],
      },
      pastPapers: {
        type: [
          {
            year: { type: Number, required: true },
            name: { type: String, required: true },
            _id: false,
          },
        ],
        default: [],
      },
    },
    engine: { type: String, required: true },
  },
  { timestamps: true }
);

questionBankSchema.index({ exam: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionBank', questionBankSchema);
