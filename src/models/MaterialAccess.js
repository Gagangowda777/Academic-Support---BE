const mongoose = require('mongoose');

// One row per student and attachment. Preview and download counters let the
// HOD report show how often a resource was opened without storing every event.
const materialAccessSchema = new mongoose.Schema(
  {
    attachment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Attachment',
      required: true,
      index: true,
    },
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
    downloads: {
      type: Number,
      default: 0,
      min: 0,
    },
    previews: {
      type: Number,
      default: 0,
      min: 0,
    },
    firstAccessedAt: {
      type: Date,
      default: Date.now,
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

materialAccessSchema.index({ attachment: 1, student: 1 }, { unique: true });
materialAccessSchema.index({ session: 1, student: 1 });

module.exports = mongoose.model('MaterialAccess', materialAccessSchema);
