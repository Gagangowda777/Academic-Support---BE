class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function notFound(req, res) {
  res.status(404).json({ message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.name === 'MulterError') {
    const messages = {
      LIMIT_FILE_SIZE: 'Each file must be 20 MB or smaller',
      LIMIT_FILE_COUNT: 'Too many files in one upload',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field in the upload',
    };
    return res.status(400).json({ message: messages[err.code] || 'Upload failed' });
  }

  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors)
      .map((item) => item.message)
      .join(', ');
    return res.status(400).json({ message });
  }

  if (err.code === 11000) {
    return res.status(409).json({ message: 'An account with that email already exists' });
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Session expired, please sign in again' });
  }

  const status = err.statusCode || 500;
  const message = status === 500 ? 'Something went wrong' : err.message;

  if (status === 500) {
    console.error('[error]', err);
  }

  return res.status(status).json({ message });
}

module.exports = { ApiError, notFound, errorHandler };
