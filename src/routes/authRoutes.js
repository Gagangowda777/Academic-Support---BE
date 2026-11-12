const express = require('express');
const rateLimit = require('express-rate-limit');
const { login, me, logout } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  // Configurable so automated checks can run; keep the default in production.
  limit: Number(process.env.LOGIN_RATE_LIMIT) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

router.post('/login', loginLimiter, login);
router.post('/logout', protect, logout);
router.get('/me', protect, me);

module.exports = router;
