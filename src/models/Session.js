const mongoose = require('mongoose');

const materialSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    objectives: {
      type: String,
      trim: true,
      default: '',
    },
    links: {
      type: [String],
      default: [],
    },
    // draft: faculty-only; absent: students marked absent for this session;
    // all: every student enrolled in the subject's batch; selected: named students.
    visibility: {
      type: String,
      enum: ['draft', 'absent', 'all', 'selected'],
      default: 'absent',
    },
    targetedStudents: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    uploadedAt: {
      type: Date,
      default: null,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: false }
);

const sessionSchema = new mongoose.Schema(
  {
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      default: null,
      index: true,
    },
    courseCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    courseName: {
      type: String,
      required: true,
      trim: true,
    },
    facultyName: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      required: true,
      trim: true,
    },
    endTime: {
      type: String,
      required: true,
      trim: true,
    },
    room: {
      type: String,
      trim: true,
      default: null,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
    },
    semester: {
      type: Number,
      default: null,
    },
    department: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ['scheduled', 'completed'],
      default: 'completed',
    },
    material: {
      type: materialSchema,
      default: null,
    },
  },
  { timestamps: true }
);

sessionSchema.index({ courseCode: 1, date: 1 }, { unique: true });

sessionSchema.methods.hasMaterial = function hasMaterial() {
  return Boolean(this.material && this.material.title);
};

module.exports = mongoose.model('Session', sessionSchema);
