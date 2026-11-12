const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Attachment = require('../models/Attachment');
const Exam = require('../models/Exam');
const Subject = require('../models/Subject');
const Session = require('../models/Session');
const { ApiError } = require('../middleware/errorHandler');

function batchForEnrollment(enrollmentId) {
  const match = /^TRN(\d{4})/.exec(String(enrollmentId || ''));
  if (!match) return null;

  const start = Number(match[1]);
  return `${start}-${start + 4}`;
}

function examDto(exam) {
  return {
    id: exam._id.toString(),
    name: exam.name,
    type: exam.type,
    date: exam.date.toISOString(),
    startTime: exam.startTime,
    endTime: exam.endTime,
    room: exam.room,
    maxMarks: exam.maxMarks,
    subject: exam.subject
      ? { id: exam.subject._id.toString(), code: exam.subject.code, name: exam.subject.name }
      : null,
  };
}

function attachmentDto(attachment) {
  return {
    id: attachment._id.toString(),
    name: attachment.originalName,
    extension: (attachment.originalName.split('.').pop() || '').toUpperCase(),
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
  };
}

function materialDto(material, files, studentId) {
  if (!material || !material.title) return null;

  const visibility = material.visibility || 'absent';
  if (visibility === 'draft') return null;
  if (
    visibility === 'selected' &&
    (!studentId ||
      !(material.targetedStudents || []).some((id) => id.toString() === studentId.toString()))
  ) {
    return null;
  }

  return {
    title: material.title,
    description: material.description || '',
    objectives: material.objectives || '',
    links: material.links || [],
    visibility,
    uploadedAt: material.uploadedAt ? material.uploadedAt.toISOString() : null,
    attachments: files.map(attachmentDto),
  };
}

/**
 * Everything the student dashboard needs in one request: profile, attendance
 * stats, the classes they were marked absent in (with that session's material
 * and review state), and their full attendance log.
 */
async function getOverview(req, res, next) {
  try {
    const records = await Attendance.find({ student: req.user._id })
      .populate('session')
      .sort({ markedAt: -1 })
      .lean();

    const rows = records
      .filter((record) => record.session)
      .sort((a, b) => new Date(b.session.date) - new Date(a.session.date));

    const missedRows = rows.filter((record) => record.status === 'absent');
    const missedIds = missedRows.map((record) => record.session._id);
    const batch = batchForEnrollment(req.user.enrollmentId);

    const batchSubjects = batch
      ? await Subject.find({ batch }).select('_id').lean()
      : [];
    const sharedSubjectIds = batchSubjects.map((subject) => subject._id);

    const sharedSessions = sharedSubjectIds.length
      ? await Session.find({
          subject: { $in: sharedSubjectIds },
          _id: { $nin: missedIds },
          'material.visibility': 'all',
          'material.title': { $ne: null },
        })
          .sort({ date: -1 })
          .limit(30)
          .lean()
      : [];

    const targetedSessions = await Session.find({
      _id: { $nin: missedIds },
      'material.visibility': 'selected',
      'material.targetedStudents': req.user._id,
    })
      .sort({ date: -1 })
      .limit(30)
      .lean();

    const attachmentSessionIds = [
      ...missedIds,
      ...sharedSessions.map((session) => session._id),
      ...targetedSessions.map((session) => session._id),
    ];

    const attachments = attachmentSessionIds.length
      ? await Attachment.find({ session: { $in: attachmentSessionIds } })
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const filesBySession = new Map();
    for (const attachment of attachments) {
      const key = attachment.session.toString();
      const list = filesBySession.get(key) || [];
      list.push(attachment);
      filesBySession.set(key, list);
    }

    const missedSessions = missedRows.map((record) => {
      const { session } = record;

      return {
        id: session._id.toString(),
        courseCode: session.courseCode,
        courseName: session.courseName,
        topic: session.topic,
        facultyName: session.facultyName,
        date: session.date.toISOString(),
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
        reviewed: Boolean(record.reviewedAt),
        reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
        markedAt: (record.markedAt || record.updatedAt || record.createdAt).toISOString(),
        material: materialDto(
          session.material,
          filesBySession.get(session._id.toString()) || [],
          req.user._id
        ),
      };
    });

    const sharedMaterials = sharedSessions.map((session) => ({
      id: session._id.toString(),
      courseCode: session.courseCode,
      courseName: session.courseName,
      topic: session.topic,
      facultyName: session.facultyName,
      date: session.date.toISOString(),
      startTime: session.startTime,
      endTime: session.endTime,
      room: session.room,
      reviewed: false,
      shared: true,
      material: materialDto(
        session.material,
        filesBySession.get(session._id.toString()) || [],
        req.user._id
      ),
    }));

    const targetedMaterialRows = targetedSessions.map((session) => ({
      id: session._id.toString(),
      courseCode: session.courseCode,
      courseName: session.courseName,
      topic: session.topic,
      facultyName: session.facultyName,
      date: session.date.toISOString(),
      startTime: session.startTime,
      endTime: session.endTime,
      room: session.room,
      reviewed: false,
      shared: true,
      targeted: true,
      material: materialDto(
        session.material,
        filesBySession.get(session._id.toString()) || [],
        req.user._id
      ),
    }));

    const availableSharedMaterials = [
      ...sharedMaterials,
      ...targetedMaterialRows,
    ];

    const attendance = rows.map((record) => ({
      sessionId: record.session._id.toString(),
      courseCode: record.session.courseCode,
      courseName: record.session.courseName,
      topic: record.session.topic,
      date: record.session.date.toISOString(),
      startTime: record.session.startTime,
      endTime: record.session.endTime,
      status: record.status,
      markedAt: (record.markedAt || record.updatedAt || record.createdAt).toISOString(),
    }));

    const totalSessions = rows.length;
    const missed = missedSessions.length;
    const attended = rows.filter((record) => record.status !== 'absent').length;
    const reviewed = missedSessions.filter((session) => session.reviewed).length;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const upcomingExams = batchSubjects.length
      ? await Exam.find({
          status: 'scheduled',
          date: { $gte: today },
          subject: { $in: batchSubjects.map((subject) => subject._id) },
        })
          .populate('subject')
          .sort({ date: 1 })
          .limit(6)
          .lean()
      : [];

    const recentNotes = missedSessions
      .filter((session) => session.material)
      .sort(
        (left, right) =>
          new Date(right.material.uploadedAt || 0) - new Date(left.material.uploadedAt || 0)
      )
      .slice(0, 5)
      .map((session) => ({
        sessionId: session.id,
        courseCode: session.courseCode,
        courseName: session.courseName,
        topic: session.topic,
        title: session.material.title,
        uploadedAt: session.material.uploadedAt,
        attachmentCount: session.material.attachments.length,
        facultyName: session.facultyName,
        reviewed: session.reviewed,
      }));

    const recentAttendance = [...rows]
      .filter((record) => record.markedAt || record.updatedAt || record.createdAt)
      .sort(
        (left, right) =>
          new Date(right.markedAt || right.updatedAt || right.createdAt) -
          new Date(left.markedAt || left.updatedAt || left.createdAt)
      )
      .slice(0, 7);

    const noteNotifications = recentNotes.map((note) => ({
      id: `notes:${note.sessionId}:${note.uploadedAt || 'unknown'}`,
      kind: 'notes',
      sessionId: note.sessionId,
      title: `New notes uploaded for ${note.courseCode}`,
      message: note.facultyName ? `${note.title} · ${note.facultyName}` : note.title,
      at: note.uploadedAt,
    }));

    const attendanceNotifications = recentAttendance.map((record) => {
      const at = (record.markedAt || record.updatedAt || record.createdAt).toISOString();

      return {
        id: `attendance:${record.session._id.toString()}:${at}`,
        kind: 'attendance',
        sessionId: record.session._id.toString(),
        title: `Attendance updated for ${record.session.courseCode}`,
        message: `Marked ${record.status} · ${record.session.topic}`,
        at,
      };
    });

    const notifications = [...noteNotifications, ...attendanceNotifications]
      .filter((item) => item.at)
      .sort((left, right) => new Date(right.at) - new Date(left.at))
      .slice(0, 8);

    res.set('Cache-Control', 'private, no-store');

    return res.status(200).json({
      student: req.user.toSafeJSON(),
      stats: {
        totalSessions,
        attended,
        missed,
        reviewed,
        resourcesAvailable: missedSessions.filter(
          (session) => session.material && session.material.attachments.length
        ).length + availableSharedMaterials.filter(
          (session) => session.material && session.material.attachments.length
        ).length,
        attendanceRate: totalSessions ? Math.round((attended / totalSessions) * 100) : 0,
      },
      missedSessions,
      sharedMaterials: availableSharedMaterials,
      attendance,
      upcomingExams: upcomingExams.map(examDto),
      recentNotes,
      notifications,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Learning-progress marker, separate from attendance. Only the signed-in
 * student's own missed session can be marked.
 */
async function setReviewed(req, res, next) {
  try {
    const { sessionId } = req.params;

    if (!mongoose.isValidObjectId(sessionId)) {
      throw new ApiError(400, 'Invalid class session');
    }

    const reviewed = req.body?.reviewed !== false;

    const record = await Attendance.findOne({ session: sessionId, student: req.user._id });

    if (!record) {
      throw new ApiError(404, 'That class session is not on your attendance record');
    }

    if (record.status !== 'absent') {
      throw new ApiError(403, 'Only sessions you missed can be marked as reviewed');
    }

    record.reviewedAt = reviewed ? record.reviewedAt || new Date() : null;
    await record.save();

    res.set('Cache-Control', 'private, no-store');

    return res.status(200).json({
      message: reviewed ? 'Marked as reviewed' : 'Review cleared',
      reviewed: Boolean(record.reviewedAt),
      reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getOverview, setReviewed };
