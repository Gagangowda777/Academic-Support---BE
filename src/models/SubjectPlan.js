const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    topics: {
      type: String,
      trim: true,
      default: '',
      maxlength: 3000,
    },
  },
  { _id: false }
);

const componentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    maxMarks: {
      type: Number,
      required: true,
      min: 1,
      max: 1000,
    },
  },
  { _id: false }
);

// One syllabus + marks scheme per subject. The exam cell edits it in place.
const subjectPlanSchema = new mongoose.Schema(
  {
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: true,
      unique: true,
      index: true,
    },
    syllabus: {
      type: [unitSchema],
      default: [],
    },
    components: {
      type: [componentSchema],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubjectPlan', subjectPlanSchema);
