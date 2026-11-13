const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const Subject = require('../models/Subject');
const User = require('../models/User');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const Attachment = require('../models/Attachment');
const Exam = require('../models/Exam');
const QuestionPaper = require('../models/QuestionPaper');
const Notification = require('../models/Notification');
const { uploadVideo, deleteVideo } = require('../services/cloudinary');
const { ApiError } = require('../middleware/errorHandler');
const {
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_ZIP_BYTES,
  UPLOAD_DIR,
  metaFor,
  removeFiles,
  policyError,
  filePolicyMessage,
} = require('../middleware/upload');

function subjectDto(subject) {
  return {
    id: subject._id.toString(),
    code: subject.code,
    name: subject.name,
    department: subject.department,
    semester: subject.semester,
    academicYear: subject.academicYear,
    batch: subject.batch,
    section: subject.section,
  };
}

function studentEnrollmentPrefix(batch) {
  const match = /^(\d{4})-\d{4}$/.exec(String(batch || ''));
  return match ? `^TRN${match[1]}` : null;
}

async function subjectStudentRoster(subject) {
  const enrollmentPrefix = studentEnrollmentPrefix(subject.batch);
  if (!enrollmentPrefix) throw new ApiError(400, 'Student roster is unavailable for this batch');

  return User.find({
    role: 'student',
    department: subject.department,
    enrollmentId: new RegExp(enrollmentPrefix),
  })
    .select('name enrollmentId')
    .sort({ enrollmentId: 1, name: 1 })
    .lean();
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

async function assertOwnedAttachment(attachmentId, facultyId) {
  if (!mongoose.isValidObjectId(attachmentId)) throw new ApiError(400, 'Invalid attachment');

  const attachment = await Attachment.findById(attachmentId);
  if (!attachment) throw new ApiError(404, 'Attachment not found');

  await assertOwnedSession(attachment.session, facultyId);
  return attachment;
}

async function removeAttachmentStorage(attachment) {
  if (attachment.storageProvider === 'cloudinary') {
    if (!attachment.cloudinaryPublicId) {
      throw new ApiError(404, 'The stored video is unavailable');
    }
    await deleteVideo(attachment.cloudinaryPublicId);
    return;
  }

  const root = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(root, attachment.storedName);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, 'Invalid file reference');
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function countAttendance(records) {
  const counts = { present: 0, absent: 0, late: 0, marked: records.length };

  for (const record of records) {
    if (record.status === 'present') counts.present += 1;
    else if (record.status === 'absent') counts.absent += 1;
    else if (record.status === 'late') counts.late += 1;
  }

  return counts;
}

async function assertOwnedSession(sessionId, facultyId) {
  const session = await Session.findById(sessionId).populate('subject');

  if (!session) throw new ApiError(404, 'Class session not found');
  if (
    !session.subject ||
    !session.subject.faculty ||
    session.subject.faculty.toString() !== facultyId.toString()
  ) {
    throw new ApiError(403, 'That class session is not assigned to you');
  }

  return session;
}

function parseLinks(raw) {
  let values = [];

  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : raw.split(/[\n,]+/);
    } catch {
      values = raw.split(/\n+/);
    }
  }

  const links = [];

  for (const value of values) {
    const candidate = String(value || '').trim();
    if (!candidate) continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      throw new ApiError(400, `"${candidate}" is not a valid URL`);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new ApiError(400, 'Reference links must start with http:// or https://');
    }

    links.push(parsedUrl.toString());
  }

  if (links.length > 10) throw new ApiError(400, 'A maximum of 10 reference links is allowed');

  return [...new Set(links)];
}

async function overview(req, res, next) {
  try {
    const subjects = await Subject.find({ faculty: req.user._id }).sort({ code: 1 }).lean();
    const subjectIds = subjects.map((subject) => subject._id);

    const sessions = subjectIds.length
      ? await Session.find({ subject: { $in: subjectIds } }).sort({ date: -1 }).lean()
      : [];
    const sessionIds = sessions.map((session) => session._id);

    const [attendance, attachmentCounts, papers, exams] = await Promise.all([
      sessionIds.length
        ? Attendance.find({ session: { $in: sessionIds } })
            .select('session student status')
            .lean()
        : [],
      sessionIds.length
        ? Attachment.aggregate([
            { $match: { session: { $in: sessionIds } } },
            { $group: { _id: '$session', count: { $sum: 1 } } },
          ])
        : [],
      QuestionPaper.find({ faculty: req.user._id }).sort({ createdAt: -1 }).lean(),
      subjectIds.length
        ? Exam.find({ subject: { $in: subjectIds }, status: 'scheduled' })
            .populate('subject')
            .sort({ date: 1 })
            .lean()
        : [],
    ]);

    const attachmentBySession = new Map(
      attachmentCounts.map((row) => [row._id.toString(), row.count])
    );

    const recordsBySession = new Map();
    for (const record of attendance) {
      const key = record.session.toString();
      const list = recordsBySession.get(key) || [];
      list.push(record);
      recordsBySession.set(key, list);
    }

    const counts = { present: 0, absent: 0, late: 0, marked: 0 };
    for (const record of attendance) {
      if (record.status === 'present') counts.present += 1;
      else if (record.status === 'absent') counts.absent += 1;
      else if (record.status === 'late') counts.late += 1;
      counts.marked += 1;
    }

    const attendanceRate = counts.marked
      ? Math.round((counts.present / counts.marked) * 100)
      : 0;

    const subjectRows = subjects.map((subject) => {
      const owned = sessions.filter(
        (session) => session.subject?.toString() === subject._id.toString()
      );
      const ownedIds = new Set(owned.map((session) => session._id.toString()));
      const records = attendance.filter((record) => ownedIds.has(record.session.toString()));
      const present = records.filter((record) => record.status === 'present').length;
      const marked = records.length;
      const students = new Set(records.map((record) => record.student.toString()));

      return {
        ...subjectDto(subject),
        sessionCount: owned.length,
        materialCount: owned.filter(
          (session) => session.material?.title && session.material.visibility !== 'draft'
        ).length,
        attachmentCount: owned.reduce(
          (sum, session) => sum + (attachmentBySession.get(session._id.toString()) || 0),
          0
        ),
        studentCount: students.size,
        attendanceRate: marked ? Math.round((present / marked) * 100) : null,
      };
    });

    const sessionRows = sessions.map((session) => {
      const records = recordsBySession.get(session._id.toString()) || [];
      const present = records.filter((record) => record.status === 'present').length;

      return {
        id: session._id.toString(),
        subjectId: session.subject?.toString() || null,
        courseCode: session.courseCode,
        courseName: session.courseName,
        topic: session.topic,
        date: session.date.toISOString(),
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
        material: Boolean(session.material?.title && session.material.visibility !== 'draft'),
        attachmentCount: attachmentBySession.get(session._id.toString()) || 0,
        attendance: {
          present,
          absent: records.filter((record) => record.status === 'absent').length,
          late: records.filter((record) => record.status === 'late').length,
          marked: records.length,
          rate: records.length ? Math.round((present / records.length) * 100) : null,
        },
      };
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const upcomingExams = exams.filter((exam) => exam.date >= today);
    const examIds = upcomingExams.map((exam) => exam._id);
    const allPapers = examIds.length
      ? await QuestionPaper.find({ exam: { $in: examIds } }).select('exam status evaluation.total').lean()
      : [];

    const papersByExam = new Map();
    for (const paper of allPapers) {
      const key = paper.exam.toString();
      const bucket = papersByExam.get(key) || [];
      bucket.push(paper);
      papersByExam.set(key, bucket);
    }

    const myPapersByExam = new Map();
    for (const paper of papers) {
      const key = paper.exam.toString();
      const bucket = myPapersByExam.get(key) || [];
      bucket.push(paper);
      myPapersByExam.set(key, bucket);
    }

    const structuredPapers = papers.filter(
      (paper) => paper.submissionType !== 'document'
    );

    const paperStats = {
      total: papers.length,
      approved: papers.filter((paper) => paper.status === 'approved').length,
      submitted: papers.filter((paper) => paper.status === 'submitted').length,
      returned: papers.filter((paper) => paper.status === 'rejected').length,
      averageScore: structuredPapers.length
        ? Math.round(
            structuredPapers.reduce(
              (sum, paper) => sum + (paper.evaluation?.total || 0),
              0
            ) / structuredPapers.length
          )
        : 0,
    };

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      faculty: req.user.toSafeJSON(),
      stats: {
        subjects: subjects.length,
        sessions: sessions.length,
        students: new Set(attendance.map((record) => record.student.toString())).size,
        materials: sessionRows.filter((row) => row.material).length,
        pendingMaterials: sessionRows.filter((row) => !row.material).length,
        attachments: attachmentCounts.reduce((sum, row) => sum + row.count, 0),
        present: counts.present,
        absent: counts.absent,
        late: counts.late,
        marked: counts.marked,
        attendanceRate,
        upcomingExams: upcomingExams.length,
      },
      paperStats,
      subjects: subjectRows,
      recentSessions: sessionRows.slice(0, 5),
      pendingSessions: sessionRows.filter((row) => !row.material).slice(0, 5),
      upcomingExams: upcomingExams.slice(0, 5).map((exam) => {
        const examPapers = papersByExam.get(exam._id.toString()) || [];
        const mine = myPapersByExam.get(exam._id.toString()) || [];
        const best = mine.reduce(
          (top, paper) => Math.max(top, paper.evaluation?.total || 0),
          0
        );

        return {
          id: exam._id.toString(),
          name: exam.name,
          type: exam.type,
          date: exam.date.toISOString(),
          startTime: exam.startTime,
          endTime: exam.endTime,
          maxMarks: exam.maxMarks,
          subject: exam.subject
            ? { id: exam.subject._id.toString(), code: exam.subject.code, name: exam.subject.name }
            : null,
          paperCount: examPapers.length,
          myPaperCount: mine.length,
          myBestScore: best ? Math.round(best) : null,
          approved: examPapers.some((paper) => paper.status === 'approved'),
        };
      }),
      recentPapers: papers.slice(0, 4).map((paper) => ({
        id: paper._id.toString(),
        title: paper.title,
        status: paper.status,
        submissionType: paper.submissionType === 'document' ? 'document' : 'structured',
        score:
          paper.submissionType === 'document'
            ? null
            : Math.round(paper.evaluation?.total || 0),
        submittedAt: paper.createdAt ? paper.createdAt.toISOString() : null,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function classes(req, res, next) {
  try {
    const subjects = await Subject.find({ faculty: req.user._id }).sort({ semester: 1, code: 1 }).lean();
    const subjectIds = subjects.map((subject) => subject._id);

    const sessions = await Session.find({ subject: { $in: subjectIds } })
      .sort({ date: -1 })
      .lean();

    const sessionIds = sessions.map((session) => session._id);
    const attendance = sessionIds.length
      ? await Attendance.find({ session: { $in: sessionIds } })
          .select('session student status')
          .lean()
      : [];

    const bySubject = new Map();

    for (const session of sessions) {
      const key = session.subject.toString();
      const bucket = bySubject.get(key) || { sessions: [], present: 0, absent: 0, students: new Set() };

      bucket.sessions.push(session);
      bySubject.set(key, bucket);
    }

    const sessionToSubject = new Map(
      sessions.map((session) => [session._id.toString(), session.subject.toString()])
    );

    for (const record of attendance) {
      const subjectKey = sessionToSubject.get(record.session.toString());
      const bucket = bySubject.get(subjectKey);
      if (!bucket) continue;

      bucket.students.add(record.student.toString());
      if (record.status === 'absent') bucket.absent += 1;
      else if (record.status === 'present') bucket.present += 1;
    }

    const payload = subjects.map((subject) => {
      const bucket = bySubject.get(subject._id.toString()) || {
        sessions: [],
        present: 0,
        absent: 0,
        students: new Set(),
      };

      return {
        ...subjectDto(subject),
        sessionCount: bucket.sessions.length,
        completedSessions: bucket.sessions.filter((session) => session.status === 'completed').length,
        materialCount: bucket.sessions.filter(
          (session) => session.material?.title && session.material.visibility !== 'draft'
        ).length,
        presentCount: bucket.present,
        absentCount: bucket.absent,
        studentCount: bucket.students.size,
      };
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ faculty: req.user.toSafeJSON(), subjects: payload });
  } catch (error) {
    return next(error);
  }
}

async function subjectSessions(req, res, next) {
  try {
    const { subjectId } = req.params;

    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findOne({ _id: subjectId, faculty: req.user._id }).lean();
    if (!subject) throw new ApiError(404, 'Subject not found for your account');

    const sessions = await Session.find({ subject: subject._id }).sort({ date: -1 }).lean();
    const sessionIds = sessions.map((session) => session._id);

    const attendance = sessionIds.length
      ? await Attendance.find({ session: { $in: sessionIds } }).select('session status').lean()
      : [];

    const attachments = sessionIds.length
      ? await Attachment.find({ session: { $in: sessionIds } })
          .select('session originalName size kind mimeType')
          .lean()
      : [];

    const countMap = new Map();
    for (const record of attendance) {
      const key = record.session.toString();
      const counts = countMap.get(key) || { present: 0, absent: 0, late: 0, marked: 0 };
      counts[record.status] = (counts[record.status] || 0) + 1;
      counts.marked += 1;
      countMap.set(key, counts);
    }

    const attachmentMap = new Map();
    for (const attachment of attachments) {
      const key = attachment.session.toString();
      const list = attachmentMap.get(key) || [];
      list.push(attachmentDto(attachment));
      attachmentMap.set(key, list);
    }

    const payload = sessions.map((session) => {
      const counts = countMap.get(session._id.toString()) || {
        present: 0,
        absent: 0,
        late: 0,
        marked: 0,
      };
      const files = attachmentMap.get(session._id.toString()) || [];

      return {
        id: session._id.toString(),
        topic: session.topic,
        date: session.date.toISOString(),
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
        status: session.status,
        attendance: counts,
        material: session.material && session.material.title
          ? {
              title: session.material.title,
              visibility: session.material.visibility || 'absent',
              uploadedAt: session.material.uploadedAt ? session.material.uploadedAt.toISOString() : null,
              attachmentCount: files.length,
            }
          : null,
      };
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ subject: subjectDto(subject), sessions: payload });
  } catch (error) {
    return next(error);
  }
}

async function subjectStudents(req, res, next) {
  try {
    const { subjectId } = req.params;

    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findOne({ _id: subjectId, faculty: req.user._id }).lean();
    if (!subject) throw new ApiError(404, 'Subject not found for your account');

    const students = await subjectStudentRoster(subject);
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      students: students.map((student) => ({
        id: student._id.toString(),
        name: student.name,
        enrollmentId: student.enrollmentId,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function sessionDetail(req, res, next) {
  try {
    const { sessionId } = req.params;

    if (!mongoose.isValidObjectId(sessionId)) throw new ApiError(400, 'Invalid session');

    const session = await assertOwnedSession(sessionId, req.user._id);
    const records = await Attendance.find({ session: session._id }).lean();
    const files = await Attachment.find({ session: session._id }).sort({ createdAt: 1 }).lean();

    const material = session.material && session.material.title
      ? {
          title: session.material.title,
          description: session.material.description || '',
          objectives: session.material.objectives || '',
          links: session.material.links || [],
          visibility: session.material.visibility || 'absent',
          targetedStudents: (session.material.targetedStudents || []).map((studentId) =>
            studentId.toString()
          ),
          uploadedAt: session.material.uploadedAt ? session.material.uploadedAt.toISOString() : null,
          attachments: files.map(attachmentDto),
        }
      : null;

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      session: {
        id: session._id.toString(),
        topic: session.topic,
        courseCode: session.courseCode,
        courseName: session.courseName,
        date: session.date.toISOString(),
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
        status: session.status,
        facultyName: session.facultyName,
        attendance: countAttendance(records),
        material,
      },
      subject: subjectDto(session.subject),
      uploadPolicy: {
        allowedExtensions: ALLOWED_EXTENSIONS,
        maxFileBytes: MAX_FILE_BYTES,
        maxZipBytes: MAX_ZIP_BYTES,
        policy: filePolicyMessage(),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function uploadMaterial(req, res, next) {
  const files = req.files || [];
  const cloudinaryAssets = [];
  const createdAttachments = [];

  try {
    const { sessionId } = req.params;

    if (!mongoose.isValidObjectId(sessionId)) throw new ApiError(400, 'Invalid session');

    const session = await assertOwnedSession(sessionId, req.user._id);

    const title = String(req.body.title || '').trim();
    if (!title) throw new ApiError(400, 'A topic/title is required');
    if (title.length > 160) throw new ApiError(400, 'The title must be 160 characters or fewer');

    const description = String(req.body.description || '').trim();
    const objectives = String(req.body.objectives || '').trim();
    const requestedVisibility = String(
      req.body.visibility || session.material?.visibility || 'absent'
    ).trim();

    if (!['draft', 'absent', 'all', 'selected'].includes(requestedVisibility)) {
      throw new ApiError(400, 'Choose a valid publishing option');
    }

    let targetedStudents = [];
    if (requestedVisibility === 'selected') {
      let studentIds = req.body.studentIds || [];
      if (typeof studentIds === 'string') {
        try {
          studentIds = JSON.parse(studentIds);
        } catch {
          throw new ApiError(400, 'Choose one or more valid students');
        }
      }

      if (!Array.isArray(studentIds) || !studentIds.length) {
        throw new ApiError(400, 'Choose at least one student to publish this material to');
      }
      if (studentIds.some((studentId) => !mongoose.isValidObjectId(studentId))) {
        throw new ApiError(400, 'Choose one or more valid students');
      }

      const roster = await subjectStudentRoster(session.subject);
      const rosterIds = new Set(roster.map((student) => student._id.toString()));
      targetedStudents = [...new Set(studentIds.map((studentId) => studentId.toString()))];
      if (targetedStudents.some((studentId) => !rosterIds.has(studentId))) {
        throw new ApiError(400, 'One or more selected students are not in this subject');
      }
    }

    if (description.length > 2000) throw new ApiError(400, 'The description is too long');
    if (objectives.length > 2000) throw new ApiError(400, 'The learning objectives are too long');

    const links = parseLinks(req.body.links);

    for (const file of files) {
      const meta = metaFor(file.originalname);
      if (!meta) throw policyError('Unsupported file type');
      if (meta.kind === 'archive' && file.size > MAX_ZIP_BYTES) {
        throw policyError('Zip archives must be 10 MB or smaller');
      }
    }

    const publicIdsByFile = new Map();
    for (const file of files) {
      const meta = metaFor(file.originalname);
      if (meta.kind !== 'video') continue;

      const publicId = `class-materials/${file.filename.replace(/\.mp4$/i, '')}`;
      const uploaded = await uploadVideo(file.path, publicId);
      cloudinaryAssets.push(uploaded.public_id);
      publicIdsByFile.set(file.filename, uploaded.public_id);
    }

    session.material = {
      title,
      description,
      objectives,
      links,
      visibility: requestedVisibility,
      targetedStudents,
      uploadedAt: new Date(),
      uploadedBy: req.user._id,
    };
    await session.save();

    for (const file of files) {
      const meta = metaFor(file.originalname);

      const attachment = await Attachment.create({
        session: session._id,
        originalName: file.originalname,
        storedName: file.filename,
        storageProvider: meta.kind === 'video' ? 'cloudinary' : 'local',
        cloudinaryPublicId: publicIdsByFile.get(file.filename) || null,
        mimeType: meta.mimeType,
        size: file.size,
        kind: meta.kind,
        uploadedBy: req.user._id,
      });
      createdAttachments.push(attachment);
    }

    removeFiles(files.filter((file) => publicIdsByFile.has(file.filename)));

    const visibilityMessage =
      requestedVisibility === 'draft'
        ? 'Material saved as draft'
        : requestedVisibility === 'all'
          ? 'Material published to all enrolled students'
          : requestedVisibility === 'selected'
            ? `Material published to ${targetedStudents.length} selected student${targetedStudents.length === 1 ? '' : 's'}`
          : 'Material published to absent students';

    return res.status(201).json({
      message: createdAttachments.length
        ? `${visibilityMessage} with ${createdAttachments.length} attachment${createdAttachments.length === 1 ? '' : 's'}`
        : visibilityMessage,
      uploaded: createdAttachments.map(attachmentDto),
    });
  } catch (error) {
    // Never leave orphaned uploads behind when validation fails.
    removeFiles(files);
    if (createdAttachments.length) {
      try {
        await Attachment.deleteMany({ _id: { $in: createdAttachments.map((item) => item._id) } });
      } catch (cleanupError) {
        console.error('[faculty] uploaded attachment cleanup failed:', cleanupError.message);
      }
    }
    for (const publicId of cloudinaryAssets) {
      try {
        await deleteVideo(publicId);
      } catch (cleanupError) {
        console.error('[faculty] uploaded video cleanup failed:', cleanupError.message);
      }
    }
    return next(error);
  }
}

async function replaceMaterialAttachment(req, res, next) {
  const file = req.file;
  let uploadedPublicId = null;
  let saved = false;

  try {
    if (!file) throw new ApiError(400, 'Choose a replacement file');

    const attachment = await assertOwnedAttachment(req.params.attachmentId, req.user._id);
    const meta = metaFor(file.originalname);
    if (!meta) throw policyError('Unsupported file type');
    if (meta.kind === 'archive' && file.size > MAX_ZIP_BYTES) {
      throw policyError('Zip archives must be 10 MB or smaller');
    }

    if (meta.kind === 'video') {
      uploadedPublicId = `class-materials/${file.filename.replace(/\.mp4$/i, '')}`;
      await uploadVideo(file.path, uploadedPublicId);
    }

    const previousStorage = {
      storageProvider: attachment.storageProvider,
      cloudinaryPublicId: attachment.cloudinaryPublicId,
      storedName: attachment.storedName,
    };

    attachment.originalName = file.originalname;
    attachment.storedName = file.filename;
    attachment.storageProvider = meta.kind === 'video' ? 'cloudinary' : 'local';
    attachment.cloudinaryPublicId = uploadedPublicId;
    attachment.mimeType = meta.mimeType;
    attachment.size = file.size;
    attachment.kind = meta.kind;
    await attachment.save();
    saved = true;

    if (meta.kind === 'video') removeFiles([file]);

    let warning = null;
    try {
      await removeAttachmentStorage(previousStorage);
    } catch (cleanupError) {
      console.error('[faculty] replaced attachment cleanup failed:', cleanupError.message);
      warning = 'The new file was saved, but the previous file could not be removed.';
    }

    return res.status(200).json({
      message: 'Attachment replaced',
      warning,
      attachment: attachmentDto(attachment),
    });
  } catch (error) {
    if (!saved) {
      removeFiles([file]);
      if (uploadedPublicId) {
        try {
          await deleteVideo(uploadedPublicId);
        } catch (cleanupError) {
          console.error('[faculty] replacement upload cleanup failed:', cleanupError.message);
        }
      }
    }
    return next(error);
  }
}

async function deleteMaterialAttachment(req, res, next) {
  try {
    const attachment = await assertOwnedAttachment(req.params.attachmentId, req.user._id);
    await removeAttachmentStorage(attachment);
    await attachment.deleteOne();

    return res.status(200).json({ message: 'Attachment deleted' });
  } catch (error) {
    return next(error);
  }
}

async function deleteSessionMaterial(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!mongoose.isValidObjectId(sessionId)) throw new ApiError(400, 'Invalid session');

    const session = await assertOwnedSession(sessionId, req.user._id);
    const attachments = await Attachment.find({ session: session._id });

    for (const attachment of attachments) {
      await removeAttachmentStorage(attachment);
      await attachment.deleteOne();
    }

    session.material = null;
    await session.save();

    return res.status(200).json({ message: 'Material deleted' });
  } catch (error) {
    return next(error);
  }
}

async function notifications(req, res, next) {
  try {
    const rows = await Notification.find({ recipient: req.user._id })
      .sort({ createdAt: -1 })
      .limit(12)
      .populate('actor', 'name')
      .populate('session', 'topic courseCode date')
      .lean();

    const payload = rows.map((row) => ({
      id: row._id.toString(),
      type: row.type,
      title: row.title,
      message: row.message,
      read: Boolean(row.readAt),
      createdAt: new Date(row.createdAt).toISOString(),
      actorName: row.actor?.name || null,
      session: row.session
        ? {
            id: row.session._id.toString(),
            topic: row.session.topic,
            courseCode: row.session.courseCode,
            date: new Date(row.session.date).toISOString(),
          }
        : null,
    }));

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      notifications: payload,
      unreadCount: payload.filter((item) => !item.read).length,
    });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationsRead(req, res, next) {
  try {
    const result = await Notification.updateMany(
      { recipient: req.user._id, readAt: null },
      { $set: { readAt: new Date() } }
    );

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      message: result.modifiedCount
        ? `${result.modifiedCount} notification${result.modifiedCount === 1 ? '' : 's'} marked as read.`
        : 'No unread notifications.',
      unreadCount: 0,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  overview,
  classes,
  subjectSessions,
  subjectStudents,
  sessionDetail,
  uploadMaterial,
  replaceMaterialAttachment,
  deleteMaterialAttachment,
  deleteSessionMaterial,
  notifications,
  markNotificationsRead,
};
