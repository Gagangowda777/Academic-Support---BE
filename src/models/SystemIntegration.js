const mongoose = require('mongoose');

const INTEGRATION_KEYS = ['erp', 'sis'];
const INTEGRATION_STATUSES = ['not_configured', 'unverified', 'connected', 'error', 'disabled'];

const systemIntegrationSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: INTEGRATION_KEYS,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: 300,
    },
    endpoint: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    syncFrequencyMinutes: {
      type: Number,
      default: 60,
      min: 5,
      max: 10080,
    },
    status: {
      type: String,
      enum: INTEGRATION_STATUSES,
      default: 'not_configured',
    },
    lastCheckedAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
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

module.exports = mongoose.model('SystemIntegration', systemIntegrationSchema);
module.exports.INTEGRATION_KEYS = INTEGRATION_KEYS;
module.exports.INTEGRATION_STATUSES = INTEGRATION_STATUSES;
