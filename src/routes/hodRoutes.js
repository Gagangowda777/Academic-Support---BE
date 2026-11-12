const express = require('express');
const {
  overview,
  facultyList,
  subjects,
  subjectSessions,
  assignFaculty,
  attendanceOverview,
  examinations,
  createDepartmentExam,
  updateDepartmentExam,
  deleteDepartmentExam,
  reports,
  sendMaterialReminder,
} = require('../controllers/hodController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Department-scoped routes; each handler filters by the HOD's department.
router.use(protect, authorize('hod'));

router.get('/overview', overview);
router.get('/faculty', facultyList);
router.get('/subjects', subjects);
router.get('/subjects/:subjectId/sessions', subjectSessions);
router.patch('/subjects/:subjectId/faculty', assignFaculty);
router.get('/attendance', attendanceOverview);
router.get('/examinations', examinations);
router.post('/exams', createDepartmentExam);
router.patch('/exams/:examId', updateDepartmentExam);
router.delete('/exams/:examId', deleteDepartmentExam);
router.get('/reports', reports);
router.post('/sessions/:sessionId/reminder', sendMaterialReminder);

module.exports = router;
