const express = require('express');
const {
  overview,
  listExams,
  createExam,
  updateExam,
  deleteExam,
  subjectPlans,
  getPlan,
  savePlan,
} = require('../controllers/examCellController');
const {
  listPapersForExamCell,
  approvePaper,
  rejectPaper,
} = require('../controllers/questionPaperController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Examination Cell only.
router.use(protect, authorize('exam_cell'));

router.get('/overview', overview);
router.get('/exams', listExams);
router.post('/exams', createExam);
router.patch('/exams/:examId', updateExam);
router.delete('/exams/:examId', deleteExam);

router.get('/subjects', subjectPlans);
router.get('/subjects/:subjectId/plan', getPlan);
router.put('/subjects/:subjectId/plan', savePlan);

router.get('/question-papers', listPapersForExamCell);
router.post('/question-papers/:paperId/approve', approvePaper);
router.post('/question-papers/:paperId/reject', rejectPaper);

module.exports = router;
