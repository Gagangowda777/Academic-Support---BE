const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads')
);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Upload policy. The server decides the stored content type from the extension
 * instead of trusting the client-provided MIME type, files are renamed with a
 * random id, and nothing is ever served as static content.
 */
const ALLOWED_TYPES = {
  '.pdf': { mimeType: 'application/pdf', kind: 'document' },
  '.doc': { mimeType: 'application/msword', kind: 'document' },
  '.docx': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
  },
  '.ppt': { mimeType: 'application/vnd.ms-powerpoint', kind: 'document' },
  '.pptx': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
  },
  '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
  '.png': { mimeType: 'image/png', kind: 'image' },
  '.zip': { mimeType: 'application/zip', kind: 'archive' },
  '.mp4': { mimeType: 'video/mp4', kind: 'video' },
};

const ALLOWED_EXTENSIONS = Object.keys(ALLOWED_TYPES);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 6;

function policyError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function metaFor(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  const meta = ALLOWED_TYPES[extension];
  if (!meta) return null;
  return { extension, ...meta };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const meta = metaFor(file.originalname);

    if (!meta) {
      return cb(
        policyError(
          `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
        )
      );
    }

    // Browsers occasionally send a generic MIME type; the extension allowlist
    // and the server-side content type remain authoritative.
    const clientType = String(file.mimetype || '').toLowerCase();
    const generic = ['application/octet-stream', 'binary/octet-stream', ''];
    if (!generic.includes(clientType) && clientType !== meta.mimeType) {
      // Allow harmless aliases for zip archives.
      const zipAliases =
        meta.kind === 'archive' && ['application/x-zip-compressed', 'multipart/x-zip'].includes(clientType);
      if (!zipAliases) {
        return cb(policyError(`The file type of "${file.originalname}" does not match its extension`));
      }
    }

    return cb(null, true);
  },
});

const PAPER_EXTENSIONS = ['.pdf', '.docx'];

/**
 * Question-paper documents use the same private disk storage as class
 * materials, but only PDF/DOCX files are accepted. The two expected
 * fields are `paperFile` and `answerKeyFile`.
 */
const paperUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    const meta = metaFor(file.originalname);

    if (!meta || !PAPER_EXTENSIONS.includes(extension)) {
      return cb(policyError('Question papers must be PDF or DOCX files'));
    }

    const clientType = String(file.mimetype || '').toLowerCase();
    const generic = ['application/octet-stream', 'binary/octet-stream', ''];
    if (!generic.includes(clientType) && clientType !== meta.mimeType) {
      return cb(
        policyError(`The file type of "${file.originalname}" does not match its extension`)
      );
    }

    return cb(null, true);
  },
});

const pastPaperUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 5 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    const meta = metaFor(file.originalname);

    if (!meta || !PAPER_EXTENSIONS.includes(extension)) {
      return cb(policyError('Past question papers must be PDF or DOCX files'));
    }

    const clientType = String(file.mimetype || '').toLowerCase();
    const generic = ['application/octet-stream', 'binary/octet-stream', ''];
    if (!generic.includes(clientType) && clientType !== meta.mimeType) {
      return cb(
        policyError(`The file type of "${file.originalname}" does not match its extension`)
      );
    }

    return cb(null, true);
  },
});

function removeFiles(files) {
  for (const file of files || []) {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

function filePolicyMessage() {
  return `Up to ${MAX_FILES} files, 20 MB each (zip archives 10 MB). Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
}

module.exports = {
  ALLOWED_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_ZIP_BYTES,
  MAX_FILES,
  PAPER_EXTENSIONS,
  UPLOAD_DIR,
  upload,
  paperUpload,
  pastPaperUpload,
  metaFor,
  removeFiles,
  policyError,
  filePolicyMessage,
};
