const express = require('express');
const { downloadPaperDocument } = require('../controllers/questionPaperController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Faculty can download their own documents; the Examination Cell and
// administrators can inspect any submitted paper.
router.get(
  '/:paperId/:kind',
  protect,
  authorize('faculty', 'exam_cell', 'academic_admin', 'super_admin'),
  downloadPaperDocument
);

module.exports = router;
