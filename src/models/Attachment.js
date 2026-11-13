const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      index: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    // Unique storage key; the original name is only used for downloads.
    storedName: {
      type: String,
      required: true,
      unique: true,
    },
    storageProvider: {
      type: String,
      enum: ['local', 'cloudinary'],
      default: 'local',
      required: true,
    },
    cloudinaryPublicId: {
      type: String,
      default: null,
      required: function requireCloudinaryPublicId() {
        return this.storageProvider === 'cloudinary';
      },
    },
    mimeType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    kind: {
      type: String,
      enum: ['document', 'image', 'archive', 'video'],
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Attachment', attachmentSchema);
