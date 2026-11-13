const fs = require('fs');
const https = require('https');
const mongoose = require('mongoose');
const path = require('path');
const Attachment = require('../models/Attachment');
const Attendance = require('../models/Attendance');
const MaterialAccess = require('../models/MaterialAccess');
const { ApiError } = require('../middleware/errorHandler');
const { UPLOAD_DIR } = require('../middleware/upload');
const { authenticatedVideoUrl } = require('../services/cloudinary');

const PREVIEWABLE_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'video/mp4',
]);

function batchForEnrollment(enrollmentId) {
  const match = /^TRN(\d{4})/.exec(String(enrollmentId || ''));
  if (!match) return null;

  const start = Number(match[1]);
  return `${start}-${start + 4}`;
}

/**
 * Loads an attachment and verifies that the signed-in user may read it. Access
 * is decided from the database, never from a client-supplied owner id: faculty
 * must own the subject, and students must have an absent attendance record for
 * that exact session.
 */
async function loadAuthorizedAttachment(req) {
  const { attachmentId } = req.params;

  if (!mongoose.isValidObjectId(attachmentId)) {
    throw new ApiError(400, 'Invalid attachment');
  }

  const attachment = await Attachment.findById(attachmentId).populate({
    path: 'session',
    populate: { path: 'subject' },
  });

  if (!attachment || !attachment.session) {
    throw new ApiError(404, 'Attachment not found');
  }

  const { session } = attachment;
  const isSubjectOwner = Boolean(
    session.subject &&
      session.subject.faculty &&
      session.subject.faculty.toString() === req.user._id.toString()
  );

  let allowed = false;

  if (req.user.role === 'faculty') {
    allowed = isSubjectOwner;
  } else if (req.user.role === 'student') {
    const record = await Attendance.findOne({ session: session._id, student: req.user._id })
      .select('status')
      .lean();
    const visibility = session.material?.visibility || 'absent';
    const isAbsent = Boolean(record && record.status === 'absent');
    const sameBatch =
      session.subject?.batch &&
      session.subject.batch === batchForEnrollment(req.user.enrollmentId);

    allowed =
      visibility === 'absent'
        ? isAbsent
        : visibility === 'all'
          ? isAbsent || Boolean(sameBatch)
          : visibility === 'selected'
            ? (session.material?.targetedStudents || []).some(
                (studentId) => studentId.toString() === req.user._id.toString()
              )
          : false;
  }

  if (!allowed) {
    throw new ApiError(403, 'You do not have access to this file');
  }

  if (attachment.storageProvider === 'cloudinary') {
    if (attachment.kind !== 'video' || !attachment.cloudinaryPublicId) {
      throw new ApiError(404, 'The stored video is unavailable');
    }
    return { attachment, filePath: null };
  }

  const root = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(root, attachment.storedName);

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, 'Invalid file reference');
  }

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    throw new ApiError(404, 'The stored file is missing');
  }

  return { attachment, filePath };
}

async function recordStudentAccess(req, attachment, kind) {
  if (req.user.role !== 'student') return;

  const now = new Date();
  const counter = kind === 'preview' ? 'previews' : 'downloads';

  try {
    await MaterialAccess.findOneAndUpdate(
      { attachment: attachment._id, student: req.user._id },
      {
        $inc: { [counter]: 1 },
        $set: { session: attachment.session._id, lastAccessedAt: now },
        $setOnInsert: { firstAccessedAt: now },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch {
    // Access analytics must never prevent a student from opening their file.
  }
}

function sendAttachment(res, attachment, filePath, disposition) {
  const safeName = attachment.originalName.replace(/["\r\n]/g, '').trim() || 'material';
  const encodedName = encodeURIComponent(safeName);

  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${safeName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodedName}`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  return res.sendFile(filePath);
}

function proxyCloudinaryVideo(req, res, attachment, disposition, next) {
  const safeName = attachment.originalName.replace(/["\r\n]/g, '').trim() || 'material.mp4';
  const encodedName = encodeURIComponent(safeName);
  const headers = req.headers.range ? { Range: req.headers.range } : {};

  try {
    const upstreamRequest = https.get(
      authenticatedVideoUrl(attachment.cloudinaryPublicId),
      { headers },
      (upstream) => {
        if (!upstream.statusCode || upstream.statusCode < 200 || upstream.statusCode >= 300) {
          upstream.resume();
          return next(new ApiError(502, 'Video storage could not serve this file'));
        }

        res.status(upstream.statusCode);
        for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
        }
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${safeName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodedName}`
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        upstream.pipe(res);
      }
    );

    upstreamRequest.on('error', (error) => {
      console.error('[materials] Cloudinary video request failed:', error.message);
      if (!res.headersSent) {
        next(new ApiError(502, 'Video storage could not serve this file'));
      } else {
        res.destroy(error);
      }
    });

    req.once('aborted', () => upstreamRequest.destroy());
    res.once('close', () => {
      if (!res.writableEnded) upstreamRequest.destroy();
    });
  } catch (error) {
    next(error);
  }
}

async function downloadAttachment(req, res, next) {
  try {
    const { attachment, filePath } = await loadAuthorizedAttachment(req);
    await recordStudentAccess(req, attachment, 'download');
    if (attachment.storageProvider === 'cloudinary') {
      return proxyCloudinaryVideo(req, res, attachment, 'attachment', next);
    }
    return sendAttachment(res, attachment, filePath, 'attachment');
  } catch (error) {
    return next(error);
  }
}

/**
 * Serves PDFs, images, and MP4 videos inline. Office documents and ZIP
 * archives are rejected instead of being rendered as untrusted HTML.
 */
async function previewAttachment(req, res, next) {
  try {
    const { attachment, filePath } = await loadAuthorizedAttachment(req);

    if (!PREVIEWABLE_TYPES.has(attachment.mimeType)) {
      throw new ApiError(415, 'This file type cannot be previewed. Download it instead.');
    }

    await recordStudentAccess(req, attachment, 'preview');
    if (attachment.storageProvider === 'cloudinary') {
      return proxyCloudinaryVideo(req, res, attachment, 'inline', next);
    }
    return sendAttachment(res, attachment, filePath, 'inline');
  } catch (error) {
    return next(error);
  }
}

module.exports = { downloadAttachment, previewAttachment };
