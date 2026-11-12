const express = require('express');
const {
  downloadAttachment,
  previewAttachment,
} = require('../controllers/materialController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Role-specific access is enforced inside the controller.
router.get('/:attachmentId/download', protect, downloadAttachment);
router.get('/:attachmentId/preview', protect, previewAttachment);

module.exports = router;
