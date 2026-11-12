const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { ApiError } = require('../middleware/errorHandler');
const { signToken, setAuthCookie, clearAuthCookie } = require('../utils/tokens');

// Used to keep failed-login timing consistent whether or not the email exists.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9r2y2V0m8v2b3FbY3n6xJ0wq6mS9r8K';

async function login(req, res, next) {
  try {
    const { email, password, role } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      throw new ApiError(400, 'Email and password are required');
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password');

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw new ApiError(401, 'Invalid email or password');
    }

    if (!user.isActive) {
      throw new ApiError(403, 'This account has been disabled');
    }

    const passwordMatches = await user.comparePassword(password);
    if (!passwordMatches) {
      throw new ApiError(401, 'Invalid email or password');
    }

    if (role && role !== user.role) {
      throw new ApiError(403, 'These credentials are not valid for the selected account type');
    }

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    const token = signToken(user);
    setAuthCookie(res, token);

    return res.status(200).json({
      message: 'Signed in successfully',
      token,
      user: user.toSafeJSON(),
    });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res) {
  return res.status(200).json({ user: req.user.toSafeJSON() });
}

async function logout(req, res) {
  clearAuthCookie(res);
  return res.status(200).json({ message: 'Signed out' });
}

module.exports = { login, me, logout };
