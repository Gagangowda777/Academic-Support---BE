const express = require('express');
const {
  overview,
  listUsers,
  academics,
  createSubject,
  updateSubject,
  assignSubjectFaculty,
  saveSubjectRequirements,
  systemSettings,
  updateSystemIntegration,
  testSystemIntegration,
  activity,
  setUserStatus,
  setUserRole,
} = require('../controllers/adminController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect, authorize('academic_admin', 'super_admin'));

router.get('/overview', overview);
router.get('/users', listUsers);
router.get('/academics', academics);
router.post('/subjects', createSubject);
router.patch('/subjects/:subjectId', updateSubject);
router.patch('/subjects/:subjectId/faculty', assignSubjectFaculty);
router.put('/subjects/:subjectId/requirements', saveSubjectRequirements);
router.get('/system', systemSettings);
router.put('/system/integrations/:key', updateSystemIntegration);
router.post('/system/integrations/:key/test', testSystemIntegration);
router.get('/activity', activity);

router.patch('/users/:userId/status', setUserStatus);
router.patch('/users/:userId/role', setUserRole);

module.exports = router;
