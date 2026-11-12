const mongoose = require('mongoose');

const recurringTopicSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true, maxlength: 150 },
    unit: { type: String, required: true, maxlength: 160 },
    frequency: { type: Number, required: true, min: 1, max: 5 },
    years: [{ type: Number }],
  },
  { _id: false }
);

const analysisSchema = new mongoose.Schema(
  {
    summary: { type: String, required: true, maxlength: 1500 },
    recurringTopics: { type: [recurringTopicSchema], default: [] },
    patterns: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    coverageGaps: { type: [String], default: [] },
  },
  { _id: false }
);

const pastPaperAnalysisSchema = new mongoose.Schema(
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
    papers: {
      type: [
        {
          year: { type: Number, required: true },
          name: { type: String, required: true },
          _id: false,
        },
      ],
      default: [],
    },
    analysis: { type: analysisSchema, required: true },
    engine: { type: String, required: true },
  },
  { timestamps: true }
);

pastPaperAnalysisSchema.index({ exam: 1, faculty: 1 }, { unique: true });

module.exports = mongoose.model('PastPaperAnalysis', pastPaperAnalysisSchema);