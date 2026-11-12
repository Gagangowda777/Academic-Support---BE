const User = require('../models/User');
const { COOKIE_NAME } = require('../utils/tokens');
const { ApiError } = require('./errorHandler');
const jwt = require('jsonwebtoken');

/**
 * Verifies the JWT from the Authorization header or the httpOnly cookie and
 * attaches the current user document to req.user.
 */
async function protect(req, res, next) {
  try {
    let token = null;

    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice(7).trim();
    }

    if (!token && req.cookies?.[COOKIE_NAME]) {
      token = req.cookies[COOKIE_NAME];
    }

    if (!token) {
      throw new ApiError(401, 'Authentication required');
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);

    if (!user || !user.isActive) {
      throw new ApiError(401, 'Account is not available');
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    return next(new ApiError(401, 'Invalid or expired session'));
  }
}

/**
 * Role gate. Every protected route must declare the roles it allows.
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));

    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have access to this resource'));
    }

    return next();
  };
}

module.exports = { protect, authorize };
