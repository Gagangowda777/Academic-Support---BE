const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['present', 'absent', 'late'],
      required: true,
    },
    markedAt: {
      type: Date,
      default: Date.now,
    },
    // Learning-progress marker set by the student. Independent of attendance.
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// One attendance record per student per session, so a re-mark cannot create a
// second (possibly contradictory) record.
attendanceSchema.index({ session: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
