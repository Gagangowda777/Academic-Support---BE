const express = require('express');
const {
  overview,
  classes,
  subjectSessions,
  subjectStudents,
  sessionDetail,
  uploadMaterial,
  notifications,
  markNotificationsRead,
} = require('../controllers/facultyController');
const {
  listFacultyPapers,
  createPaper,
  createPaperDocument,
  updatePaper,
  deletePaper,
} = require('../controllers/questionPaperController');
const {
  questionBankContext,
  uploadPastPapers,
  downloadPastPaper,
  previewPastPaper,
  previewPastPaperText,
  deletePastPaper,
  downloadQuestionBankPdf,
  downloadPastPaperAnalysisPdf,
  generateQuestionBankForExam,
  analyzePastPapersForExam,
} = require('../controllers/questionBankController');
const { protect, authorize } = require('../middleware/auth');
const {
  upload,
  paperUpload,
  pastPaperUpload,
  MAX_FILES,
} = require('../middleware/upload');

const router = express.Router();

// Faculty-only routes; each handler additionally checks subject ownership.
router.use(protect, authorize('faculty'));

router.get('/overview', overview);
router.get('/notifications', notifications);
router.patch('/notifications/read', markNotificationsRead);
router.get('/classes', classes);
router.get('/subjects/:subjectId/sessions', subjectSessions);
router.get('/subjects/:subjectId/students', subjectStudents);
router.get('/sessions/:sessionId', sessionDetail);
router.post(
  '/sessions/:sessionId/material',
  upload.array('files', MAX_FILES),
  uploadMaterial
);

// Question-paper sets for an upcoming examination.
router.get('/question-papers', listFacultyPapers);
router.post('/question-papers', createPaper);
router.post(
  '/question-papers/upload',
  paperUpload.fields([
    { name: 'paperFile', maxCount: 1 },
    { name: 'answerKeyFile', maxCount: 1 },
  ]),
  createPaperDocument
);
router.get('/question-banks/:examId/context', questionBankContext);
router.get(
  '/question-banks/past-papers/analysis/:analysisId/pdf',
  downloadPastPaperAnalysisPdf
);
router.get('/question-banks/:bankId/pdf', downloadQuestionBankPdf);
router.post(
  '/question-banks/past-papers',
  pastPaperUpload.array('files', 5),
  uploadPastPapers
);
router.get('/question-banks/past-papers/:paperId/download', downloadPastPaper);
router.get('/question-banks/past-papers/:paperId/preview', previewPastPaper);
router.get('/question-banks/past-papers/:paperId/text', previewPastPaperText);
router.delete('/question-banks/past-papers/:paperId', deletePastPaper);
router.post('/question-banks/generate', generateQuestionBankForExam);
router.post('/question-banks/past-papers/analyze', analyzePastPapersForExam);
router.patch('/question-papers/:paperId', updatePaper);
router.delete('/question-papers/:paperId', deletePaper);

module.exports = router;
