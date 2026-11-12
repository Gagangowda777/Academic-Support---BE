const express = require('express');
const { getOverview, setReviewed } = require('../controllers/studentController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// The student portal is never reachable with a staff or admin token.
router.use(protect, authorize('student'));

router.get('/overview', getOverview);
router.patch('/sessions/:sessionId/review', setReviewed);

module.exports = router;
