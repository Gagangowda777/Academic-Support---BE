const mongoose = require('mongoose');
const Subject = require('../models/Subject');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const Attachment = require('../models/Attachment');
const Exam = require('../models/Exam');
const QuestionPaper = require('../models/QuestionPaper');
const Notification = require('../models/Notification');
const MaterialAccess = require('../models/MaterialAccess');
const User = require('../models/User');
const { recommendationFrom } = require('../services/paperEvaluator');
const { ApiError } = require('../middleware/errorHandler');
const { examDto: scheduledExamDto, validateExamPayload } = require('./examCellController');

const LOW_ATTENDANCE = 75;
const MATERIAL_SLA_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

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

function facultyDto(faculty) {
  if (!faculty) return null;

  return {
    id: faculty._id.toString(),
    name: faculty.name,
    email: faculty.email,
    department: faculty.department,
  };
}

function attendanceRate(present, marked) {
  return marked ? Math.round((present / marked) * 100) : null;
}

function countByStatus(records) {
  const counts = { present: 0, absent: 0, late: 0, marked: records.length };

  for (const record of records) {
    if (record.status === 'present') counts.present += 1;
    else if (record.status === 'absent') counts.absent += 1;
    else if (record.status === 'late') counts.late += 1;
  }

  counts.rate = attendanceRate(counts.present, counts.marked);
  return counts;
}

/** Minutes since midnight for strings such as "09:00 AM". */
function clockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(value || '').trim());
  if (!match) return null;

  const hours = Number(match[1]) % 12;
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  return (meridiem === 'PM' ? hours + 12 : hours) * 60 + minutes;
}

function overlaps(first, second) {
  const firstStart = clockMinutes(first.startTime);
  const firstEnd = clockMinutes(first.endTime);
  const secondStart = clockMinutes(second.startTime);
  const secondEnd = clockMinutes(second.endTime);

  if ([firstStart, firstEnd, secondStart, secondEnd].some((value) => value === null)) {
    return false;
  }

  return firstStart < secondEnd && secondStart < firstEnd;
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function batchForEnrollment(enrollmentId) {
  const match = /^TRN(\d{4})/.exec(String(enrollmentId || ''));
  if (!match) return null;

  const start = Number(match[1]);
  return `${start}-${start + 4}`;
}

/** End of a session in UTC, used for upload turnaround and SLA deadlines. */
function sessionEnd(session) {
  const minutes = clockMinutes(session.endTime);
  if (minutes === null) return null;

  const date = new Date(session.date);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      Math.floor(minutes / 60),
      minutes % 60
    )
  );
}

function publishedMaterial(session) {
  return Boolean(
    session.material &&
      session.material.title &&
      session.material.visibility !== 'draft'
  );
}

function hoursBetween(from, to) {
  return Math.max(0, (to.getTime() - from.getTime()) / HOUR_MS);
}

function roundHours(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 10) / 10;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function accessSummary(exposures, accessedPairs, eligibleStudents, accessingStudents) {
  return {
    eligibleStudents,
    accessingStudents,
    exposures,
    accessed: accessedPairs,
    rate: exposures ? Math.round((accessedPairs / exposures) * 100) : null,
    reachRate: eligibleStudents
      ? Math.round((accessingStudents / eligibleStudents) * 100)
      : null,
  };
}

function departmentOf(req) {
  return req.user.department || null;
}

function departmentFilter(req) {
  const department = departmentOf(req);
  return department ? { department } : {};
}

async function loadSubjectSessions(subjectIds) {
  if (!subjectIds.length) return [];

  return Session.find({ subject: { $in: subjectIds } }).sort({ date: 1 }).lean();
}

async function overview(req, res, next) {
  try {
    const department = departmentOf(req);
    const [faculty, students, subjects] = await Promise.all([
      User.find({ role: 'faculty', isActive: true, ...departmentFilter(req) }).lean(),
      User.find({ role: 'student', isActive: true, ...departmentFilter(req) }).lean(),
      Subject.find(departmentFilter(req)).sort({ semester: 1, code: 1 }).lean(),
    ]);

    const subjectsById = new Map(subjects.map((subject) => [subject._id.toString(), subject]));
    const facultyById = new Map(faculty.map((member) => [member._id.toString(), member]));
    const sessions = await loadSubjectSessions(subjects.map((subject) => subject._id));
    const sessionIds = sessions.map((session) => session._id);

    const [attendance, attachments, attachmentCounts, reminders] = await Promise.all([
      sessionIds.length
        ? Attendance.find({ session: { $in: sessionIds } })
            .select('session student status')
            .lean()
        : [],
      sessionIds.length
        ? Attachment.find({ session: { $in: sessionIds } })
            .select('session originalName size')
            .sort({ createdAt: -1 })
            .lean()
        : [],
      sessionIds.length
        ? Attachment.aggregate([
            { $match: { session: { $in: sessionIds } } },
            { $group: { _id: '$session', count: { $sum: 1 } } },
          ])
        : [],
      sessionIds.length
        ? Notification.find({
            type: 'material_reminder',
            session: { $in: sessionIds },
          })
            .select('session createdAt readAt')
            .sort({ createdAt: -1 })
            .lean()
        : [],
    ]);

    const latestReminderBySession = new Map();
    for (const reminder of reminders) {
      const key = reminder.session?.toString();
      if (key && !latestReminderBySession.has(key)) {
        latestReminderBySession.set(key, reminder);
      }
    }

    const attachmentCountBySession = new Map(
      attachmentCounts.map((row) => [row._id.toString(), row.count])
    );

    const bySession = new Map();
    for (const record of attendance) {
      const key = record.session.toString();
      const list = bySession.get(key) || [];
      list.push(record);
      bySession.set(key, list);
    }

    const totals = countByStatus(attendance);
    const studentIds = new Set(attendance.map((record) => record.student.toString()));

    const sessionRows = sessions.map((session) => {
      const records = bySession.get(session._id.toString()) || [];
      const counts = countByStatus(records);

      return {
        id: session._id.toString(),
        subjectId: session.subject ? session.subject.toString() : null,
        subjectCode: session.courseCode,
        subjectName: subjectsById.get(session.subject?.toString())?.name || session.courseName,
        topic: session.topic,
        date: session.date.toISOString(),
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
        facultyName: session.facultyName,
        material: publishedMaterial(session),
        materialDraft: Boolean(session.material?.title && session.material.visibility === 'draft'),
        reminderSentAt: latestReminderBySession.get(session._id.toString())?.createdAt
          ? latestReminderBySession.get(session._id.toString()).createdAt.toISOString()
          : null,
        attachmentCount: attachmentCountBySession.get(session._id.toString()) || 0,
        attendance: {
          present: counts.present,
          absent: counts.absent,
          late: counts.late,
          marked: counts.marked,
          rate: counts.rate,
        },
      };
    });

    const recentSessions = [...sessionRows]
      .sort((first, second) => new Date(second.date) - new Date(first.date))
      .slice(0, 5);

    const recentMaterials = sessions
      .filter((session) => publishedMaterial(session))
      .sort(
        (first, second) =>
          new Date(second.material.uploadedAt || second.date) -
          new Date(first.material.uploadedAt || first.date)
      )
      .slice(0, 5)
      .map((session) => {
        const subject = subjectsById.get(session.subject?.toString());
        const uploader = session.material.uploadedBy
          ? facultyById.get(session.material.uploadedBy.toString())
          : null;

        return {
          sessionId: session._id.toString(),
          subjectId: subject ? subject._id.toString() : null,
          subjectCode: session.courseCode,
          subjectName: subject?.name || session.courseName,
          topic: session.topic,
          title: session.material.title,
          uploadedAt: session.material.uploadedAt ? session.material.uploadedAt.toISOString() : null,
          attachmentCount: attachmentCountBySession.get(session._id.toString()) || 0,
          uploadedBy: uploader?.name || null,
        };
      });

    const facultyRows = faculty.map((member) => {
      const owned = subjects.filter(
        (subject) => subject.faculty && subject.faculty.toString() === member._id.toString()
      );
      const ownedIds = new Set(owned.map((subject) => subject._id.toString()));
      const ownedSessions = sessionRows.filter((row) => ownedIds.has(row.subjectId));

      return {
        ...facultyDto(member),
        subjectCount: owned.length,
        subjects: owned.map(subjectDto),
        sessionCount: ownedSessions.length,
        materialCount: ownedSessions.filter((row) => row.material).length,
      };
    });

    const sessionsWithoutMaterial = sessionRows.filter((row) => !row.material).length;
    const lowAttendanceStudents = new Set();

    // A student at risk is one whose own attendance rate is below the threshold.
    const perStudent = new Map();
    for (const record of attendance) {
      const key = record.student.toString();
      const bucket = perStudent.get(key) || { present: 0, marked: 0 };
      bucket.marked += 1;
      if (record.status === 'present') bucket.present += 1;
      perStudent.set(key, bucket);
    }

    for (const bucket of perStudent.values()) {
      const rate = attendanceRate(bucket.present, bucket.marked);
      if (rate !== null && rate < LOW_ATTENDANCE) lowAttendanceStudents.add(bucket);
    }

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      department,
      stats: {
        faculty: faculty.length,
        students: students.length,
        subjects: subjects.length,
        assignedSubjects: subjects.filter((subject) => subject.faculty).length,
        sessions: sessionRows.length,
        completedSessions: sessionRows.length,
        materials: sessionRows.filter((row) => row.material).length,
        attachments: attachments.length,
        sessionsWithoutMaterial,
        present: totals.present,
        absent: totals.absent,
        late: totals.late,
        marked: totals.marked,
        attendanceRate: totals.rate,
        studentsWithRecords: studentIds.size,
        lowAttendanceStudents: lowAttendanceStudents.size,
        lowAttendanceThreshold: LOW_ATTENDANCE,
      },
      faculty: facultyRows,
      recentSessions,
      recentMaterials,
    });
  } catch (error) {
    return next(error);
  }
}

async function facultyList(req, res, next) {
  try {
    const [faculty, subjects] = await Promise.all([
      User.find({ role: 'faculty', isActive: true, ...departmentFilter(req) })
        .sort({ name: 1 })
        .lean(),
      Subject.find(departmentFilter(req)).sort({ semester: 1, code: 1 }).lean(),
    ]);

    const sessions = await loadSubjectSessions(subjects.map((subject) => subject._id));
    const subjectIds = new Set(subjects.map((subject) => subject._id.toString()));
    const sessionIds = sessions.map((session) => session._id);

    const attendance = sessionIds.length
      ? await Attendance.find({ session: { $in: sessionIds } })
          .select('session student status')
          .lean()
      : [];

    const subjectBySession = new Map(
      sessions.map((session) => [session._id.toString(), session.subject?.toString() || null])
    );

    const rows = faculty.map((member) => {
      const owned = subjects.filter(
        (subject) => subject.faculty && subject.faculty.toString() === member._id.toString()
      );
      const ownedIds = new Set(owned.map((subject) => subject._id.toString()));
      const ownedSessions = sessions.filter((session) =>
        ownedIds.has(session.subject?.toString())
      );
      const ownedSessionIds = new Set(ownedSessions.map((session) => session._id.toString()));

      const records = attendance.filter((record) =>
        ownedSessionIds.has(record.session.toString())
      );
      const counts = countByStatus(records);
      const students = new Set(records.map((record) => record.student.toString()));

      return {
        ...facultyDto(member),
        subjects: owned.map(subjectDto),
        subjectCount: owned.length,
        sessionCount: ownedSessions.length,
        materialCount: ownedSessions.filter((session) => session.material?.title).length,
        studentCount: students.size,
        attendance: {
          present: counts.present,
          absent: counts.absent,
          late: counts.late,
          marked: counts.marked,
          rate: counts.rate,
        },
      };
    });

    const workload = rows.map((row) => ({
      facultyId: row.id,
      subjectCount: row.subjectCount,
      sessionCount: row.sessionCount,
    }));

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ faculty: rows, workload, activeSubjects: subjectIds.size });
  } catch (error) {
    return next(error);
  }
}

async function subjects(req, res, next) {
  try {
    const subjects = await Subject.find(departmentFilter(req)).sort({ semester: 1, code: 1 }).lean();
    const facultyIds = subjects.map((subject) => subject.faculty).filter(Boolean);
    const faculty = await User.find({ _id: { $in: facultyIds } })
      .select('name email department')
      .lean();
    const facultyById = new Map(faculty.map((member) => [member._id.toString(), member]));

    const sessions = await loadSubjectSessions(subjects.map((subject) => subject._id));
    const sessionIds = sessions.map((session) => session._id);

    const [attendance, attachments] = await Promise.all([
      sessionIds.length
        ? Attendance.find({ session: { $in: sessionIds } })
            .select('session student status')
            .lean()
        : [],
      sessionIds.length
        ? Attachment.find({ session: { $in: sessionIds } }).select('session').lean()
        : [],
    ]);

    const recordsBySession = new Map();
    for (const record of attendance) {
      const key = record.session.toString();
      const list = recordsBySession.get(key) || [];
      list.push(record);
      recordsBySession.set(key, list);
    }

    const attachmentsBySession = new Map();
    for (const attachment of attachments) {
      const key = attachment.session.toString();
      attachmentsBySession.set(key, (attachmentsBySession.get(key) || 0) + 1);
    }

    const rows = subjects.map((subject) => {
      const subjectSessions = sessions.filter(
        (session) => session.subject?.toString() === subject._id.toString()
      );
      const sessionIdsForSubject = new Set(
        subjectSessions.map((session) => session._id.toString())
      );

      const records = attendance.filter((record) =>
        sessionIdsForSubject.has(record.session.toString())
      );
      const counts = countByStatus(records);
      const students = new Set(records.map((record) => record.student.toString()));
      const attachmentCount = subjectSessions.reduce(
        (total, session) =>
          total + (attachmentsBySession.get(session._id.toString()) || 0),
        0
      );

      return {
        ...subjectDto(subject),
        faculty: facultyDto(facultyById.get(subject.faculty?.toString())),
        sessionCount: subjectSessions.length,
        completedSessions: subjectSessions.filter((session) => session.status === 'completed')
          .length,
        materialCount: subjectSessions.filter((session) => session.material?.title).length,
        attachmentCount,
        studentCount: students.size,
        attendance: {
          present: counts.present,
          absent: counts.absent,
          late: counts.late,
          marked: counts.marked,
          rate: counts.rate,
        },
      };
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ subjects: rows, lowAttendanceThreshold: LOW_ATTENDANCE });
  } catch (error) {
    return next(error);
  }
}

async function subjectSessions(req, res, next) {
  try {
    const { subjectId } = req.params;

    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findOne({ _id: subjectId, ...departmentFilter(req) }).lean();
    if (!subject) throw new ApiError(404, 'Subject not found in your department');

    const sessions = await Session.find({ subject: subject._id }).sort({ date: 1 }).lean();
    const sessionIds = sessions.map((session) => session._id);

    const [attendance, attachments] = await Promise.all([
      sessionIds.length
        ? Attendance.find({ session: { $in: sessionIds } })
            .select('session student status')
            .lean()
        : [],
      sessionIds.length
        ? Attachment.find({ session: { $in: sessionIds } })
            .select('session originalName size kind')
            .lean()
        : [],
    ]);

    const recordsBySession = new Map();
    for (const record of attendance) {
      const key = record.session.toString();
      const list = recordsBySession.get(key) || [];
      list.push(record);
      recordsBySession.set(key, list);
    }

    const filesBySession = new Map();
    for (const attachment of attachments) {
      const key = attachment.session.toString();
      const list = filesBySession.get(key) || [];
      list.push({
        id: attachment._id.toString(),
        name: attachment.originalName,
        size: attachment.size,
        kind: attachment.kind,
      });
      filesBySession.set(key, list);
    }

    const rows = sessions.map((session) => {
      const records = recordsBySession.get(session._id.toString()) || [];
      const counts = countByStatus(records);

      return {
        id: session._id.toString(),
        topic: session.topic,
        date: session.date.toISOString(),
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
        status: session.status,
        attendance: {
          present: counts.present,
          absent: counts.absent,
          late: counts.late,
          marked: counts.marked,
          rate: counts.rate,
        },
        material: publishedMaterial(session)
          ? {
              title: session.material.title,
              uploadedAt: session.material.uploadedAt
                ? session.material.uploadedAt.toISOString()
                : null,
              attachments: filesBySession.get(session._id.toString()) || [],
            }
          : null,
      };
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ subject: subjectDto(subject), sessions: rows });
  } catch (error) {
    return next(error);
  }
}

/**
 * Collects timetable clashes for a proposed faculty assignment. A clash exists
 * when two sessions of the same cohort (or of the same teacher) share a date
 * and overlapping time window.
 */
async function findConflicts(subject, faculty) {
  const proposedSessions = await Session.find({ subject: subject._id }).lean();
  if (!proposedSessions.length) return { conflicts: [], proposedSessions };

  const others = await Subject.find({
    _id: { $ne: subject._id },
    department: subject.department,
  }).lean();

  const facultySubjects = others.filter(
    (other) => other.faculty && other.faculty.toString() === faculty._id.toString()
  );
  const cohortSubjects = others.filter(
    (other) =>
      other.academicYear === subject.academicYear &&
      other.batch === subject.batch &&
      other.section === subject.section
  );

  const facultySubjectIds = new Set(facultySubjects.map((other) => other._id.toString()));
  const cohortSubjectIds = new Set(cohortSubjects.map((other) => other._id.toString()));
  const relevantIds = new Set([...facultySubjectIds, ...cohortSubjectIds]);

  const otherSessions = relevantIds.size
    ? await Session.find({ subject: { $in: [...relevantIds] } }).sort({ date: 1 }).lean()
    : [];

  const subjectById = new Map(others.map((other) => [other._id.toString(), other]));
  const conflicts = [];
  const seen = new Set();

  for (const proposed of proposedSessions) {
    for (const other of otherSessions) {
      if (dayKey(proposed.date) !== dayKey(other.date)) continue;
      if (!overlaps(proposed, other)) continue;

      const otherId = other.subject?.toString();
      if (!otherId) continue;

      const teacherClash = facultySubjectIds.has(otherId);
      const cohortClash = cohortSubjectIds.has(otherId);
      if (!teacherClash && !cohortClash) continue;

      const key = `${proposed._id.toString()}:${other._id.toString()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const otherSubject = subjectById.get(otherId);

      conflicts.push({
        type: teacherClash && cohortClash ? 'faculty-and-cohort' : teacherClash ? 'faculty' : 'cohort',
        teacherClash,
        cohortClash,
        session: {
          id: proposed._id.toString(),
          topic: proposed.topic,
          date: proposed.date.toISOString(),
          startTime: proposed.startTime,
          endTime: proposed.endTime,
          room: proposed.room,
        },
        clashWith: {
          subjectId: otherId,
          code: otherSubject?.code || other.courseCode,
          name: otherSubject?.name || other.courseName,
          batch: otherSubject?.batch || null,
          section: otherSubject?.section || null,
          facultyName: other.facultyName,
          session: {
            id: other._id.toString(),
            topic: other.topic,
            date: other.date.toISOString(),
            startTime: other.startTime,
            endTime: other.endTime,
            room: other.room,
          },
        },
      });
    }
  }

  conflicts.sort((first, second) => new Date(first.session.date) - new Date(second.session.date));
  return { conflicts, proposedSessions };
}

async function assignFaculty(req, res, next) {
  try {
    const { subjectId } = req.params;

    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findOne({ _id: subjectId, ...departmentFilter(req) });
    if (!subject) throw new ApiError(404, 'Subject not found in your department');

    const facultyId = String(req.body.facultyId || '');
    if (!mongoose.isValidObjectId(facultyId)) throw new ApiError(400, 'Select a faculty member');

    const faculty = await User.findOne({
      _id: facultyId,
      role: 'faculty',
      isActive: true,
      ...departmentFilter(req),
    });

    if (!faculty) {
      throw new ApiError(400, 'Select an active faculty member from your department');
    }

    const { conflicts } = await findConflicts(subject, faculty);
    const previousFaculty = subject.faculty
      ? await User.findById(subject.faculty).select('name email').lean()
      : null;
    const force = req.body.force === true;

    if (conflicts.length && !force) {
      res.set('Cache-Control', 'private, no-store');
      return res.status(409).json({
        message: `${faculty.name} has ${conflicts.length} timetable clash${
          conflicts.length === 1 ? '' : 'es'
        } with this class. Review the clashes or assign anyway.`,
        conflicts,
        subject: subjectDto(subject),
        suggestedFaculty: facultyDto(faculty),
      });
    }

    subject.faculty = faculty._id;
    await subject.save();
    await Session.updateMany({ subject: subject._id }, { $set: { facultyName: faculty.name } });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      message: `${subject.code} assigned to ${faculty.name}.`,
      subject: { ...subjectDto(subject), faculty: facultyDto(faculty) },
      previousFaculty: facultyDto(previousFaculty),
      conflicts,
      forced: conflicts.length > 0,
    });
  } catch (error) {
    return next(error);
  }
}

async function attendanceOverview(req, res, next) {
  try {
    const { subjectId } = req.query;
    const department = departmentOf(req);

    let subjects = await Subject.find(departmentFilter(req)).sort({ semester: 1, code: 1 }).lean();

    if (subjectId) {
      if (!mongoose.isValidObjectId(String(subjectId))) throw new ApiError(400, 'Invalid subject');
      subjects = subjects.filter((subject) => subject._id.toString() === String(subjectId));
      if (!subjects.length) throw new ApiError(404, 'Subject not found in your department');
    }

    const facultyIds = subjects.map((subject) => subject.faculty).filter(Boolean);
    const faculty = await User.find({ _id: { $in: facultyIds } })
      .select('name email department')
      .lean();
    const facultyById = new Map(faculty.map((member) => [member._id.toString(), member]));

    const sessions = await loadSubjectSessions(subjects.map((subject) => subject._id));
    const sessionIds = sessions.map((session) => session._id);
    const records = sessionIds.length
      ? await Attendance.find({ session: { $in: sessionIds } })
          .select('session student status markedAt')
          .sort({ markedAt: 1 })
          .lean()
      : [];

    const studentRecords = new Map();

    for (const record of records) {
      const key = record.student.toString();
      const bucket = studentRecords.get(key) || {
        id: key,
        present: 0,
        absent: 0,
        late: 0,
        marked: 0,
        lastMarkedAt: null,
      };

      bucket.marked += 1;
      if (record.status === 'present') bucket.present += 1;
      else if (record.status === 'absent') bucket.absent += 1;
      else if (record.status === 'late') bucket.late += 1;

      if (!bucket.lastMarkedAt || new Date(record.markedAt) > new Date(bucket.lastMarkedAt)) {
        bucket.lastMarkedAt = record.markedAt;
      }

      studentRecords.set(key, bucket);
    }

    const studentUsers = await User.find({
      _id: { $in: [...studentRecords.keys()] },
    })
      .select('name email enrollmentId department')
      .lean();

    const students = studentUsers
      .map((student) => {
        const bucket = studentRecords.get(student._id.toString());
        return {
          id: student._id.toString(),
          name: student.name,
          email: student.email,
          enrollmentId: student.enrollmentId,
          department: student.department,
          marked: bucket.marked,
          present: bucket.present,
          absent: bucket.absent,
          late: bucket.late,
          rate: attendanceRate(bucket.present, bucket.marked),
          lastMarkedAt: bucket.lastMarkedAt ? new Date(bucket.lastMarkedAt).toISOString() : null,
          lowAttendance:
            attendanceRate(bucket.present, bucket.marked) !== null &&
            attendanceRate(bucket.present, bucket.marked) < LOW_ATTENDANCE,
        };
      })
      .sort((first, second) => first.name.localeCompare(second.name));

    const subjectRows = subjects.map((subject) => {
      const subjectSessions = sessions.filter(
        (session) => session.subject?.toString() === subject._id.toString()
      );
      const subjectSessionIds = new Set(
        subjectSessions.map((session) => session._id.toString())
      );
      const subjectRecords = records.filter((record) =>
        subjectSessionIds.has(record.session.toString())
      );
      const counts = countByStatus(subjectRecords);

      return {
        ...subjectDto(subject),
        faculty: facultyDto(facultyById.get(subject.faculty?.toString())),
        sessionCount: subjectSessions.length,
        marked: counts.marked,
        rate: counts.rate,
      };
    });

    const sessionBreakdown = subjectId
      ? sessions.map((session) => {
          const sessionRecords = records.filter(
            (record) => record.session.toString() === session._id.toString()
          );
          const counts = countByStatus(sessionRecords);

          return {
            id: session._id.toString(),
            topic: session.topic,
            date: session.date.toISOString(),
            startTime: session.startTime,
            endTime: session.endTime,
            room: session.room,
            material: publishedMaterial(session),
            present: counts.present,
            absent: counts.absent,
            late: counts.late,
            marked: counts.marked,
            rate: counts.rate,
          };
        })
      : null;

    const totals = countByStatus(records);

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      department,
      scope: subjectId ? subjectRows[0] : null,
      subjects: subjectRows,
      summary: {
        students: students.length,
        sessions: sessions.length,
        present: totals.present,
        absent: totals.absent,
        late: totals.late,
        marked: totals.marked,
        rate: totals.rate,
        lowAttendance: students.filter((student) => student.lowAttendance).length,
        lowAttendanceThreshold: LOW_ATTENDANCE,
      },
      students,
      sessions: sessionBreakdown,
    });
  } catch (error) {
    return next(error);
  }
}

function paperStatus(paper) {
  const status = paper.evaluation?.status;
  if (status === 'completed' || paper.evaluation?.evaluatedAt || paper.evaluation?.total) {
    return 'evaluated';
  }
  if (status === 'failed') return 'failed';
  if (status === 'processing') return 'processing';
  return 'pending';
}

function paperDto(paper, recommendedId, approvedId) {
  const documentPaper = paper.submissionType === 'document';

  return {
    id: paper._id.toString(),
    title: paper.title,
    submissionType: documentPaper ? 'document' : 'structured',
    status: paper.status,
    aiStatus: paperStatus(paper),
    recommended:
      Boolean(recommendedId) && recommendedId === paper._id.toString(),
    approved: Boolean(approvedId) && approvedId === paper._id.toString(),
    faculty: paper.faculty
      ? {
          id: paper.faculty._id.toString(),
          name: paper.faculty.name,
          email: paper.faculty.email,
        }
      : null,
    questionCount: documentPaper ? 0 : paper.questions?.length || 0,
    totalMarks: paper.totalMarks || 0,
    score:
      paperStatus(paper) === 'evaluated'
        ? Math.round(paper.evaluation?.total || 0)
        : null,
    evaluatedAt: paper.evaluation?.evaluatedAt
      ? new Date(paper.evaluation.evaluatedAt).toISOString()
      : null,
    summary: paper.evaluation?.summary || '',
    evaluationError: paper.evaluation?.error || '',
    risks: (paper.evaluation?.risks || []).slice(0, 2),
    breakdown: (paper.evaluation?.breakdown || []).map((criterion) => ({
      key: criterion.key,
      label: criterion.label,
      score: criterion.score,
      weight: criterion.weight,
      earned: criterion.earned,
    })),
    submittedAt: paper.createdAt ? new Date(paper.createdAt).toISOString() : null,
    reviewedAt: paper.reviewedAt ? new Date(paper.reviewedAt).toISOString() : null,
  };
}

async function examinations(req, res, next) {
  try {
    const subjects = await Subject.find(departmentFilter(req)).lean();
    const subjectIds = subjects.map((subject) => subject._id);

    if (!subjectIds.length) {
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json({
        module: 'Module B',
        stats: {
          exams: 0,
          papers: 0,
          evaluated: 0,
          pendingEvaluation: 0,
          awaitingReview: 0,
          approved: 0,
          averageScore: null,
          highestScore: null,
          submissionRate: null,
        },
        scoreBands: { excellent: 0, good: 0, needsReview: 0 },
        exams: [],
      });
    }

    const exams = await Exam.find({ subject: { $in: subjectIds } })
      .populate('subject')
      .sort({ date: -1 })
      .lean();
    const examIds = exams.map((exam) => exam._id);
    const papers = examIds.length
      ? await QuestionPaper.find({ exam: { $in: examIds } })
          .populate('faculty', 'name email')
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const papersByExam = new Map();
    for (const paper of papers) {
      const key = paper.exam.toString();
      const bucket = papersByExam.get(key) || [];
      bucket.push(paper);
      papersByExam.set(key, bucket);
    }

    const evaluatedPapers = papers.filter((paper) => paperStatus(paper) === 'evaluated');
    const scores = evaluatedPapers.map((paper) => paper.evaluation?.total || 0);
    const averageScore = scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : null;
    const highestScore = scores.length ? Math.round(Math.max(...scores)) : null;

    const examRows = exams.map((exam) => {
      const examPapers = papersByExam.get(exam._id.toString()) || [];
      const recommendedId = recommendationFrom(examPapers);
      const approvedId = exam.approvedPaper ? exam.approvedPaper.toString() : null;
      const rows = examPapers.map((paper) => paperDto(paper, recommendedId, approvedId));
      const examScores = rows
        .filter((paper) => paper.aiStatus === 'evaluated')
        .map((paper) => paper.score);

      return {
        id: exam._id.toString(),
        name: exam.name,
        type: exam.type,
        date: exam.date.toISOString(),
        startTime: exam.startTime,
        endTime: exam.endTime,
        status: exam.status,
        maxMarks: exam.maxMarks,
        passMarks: exam.passMarks,
        room: exam.room,
        notes: exam.notes || '',
        subject: exam.subject ? subjectDto(exam.subject) : null,
        paperCount: rows.length,
        structuredCount: rows.filter((paper) => paper.submissionType === 'structured').length,
        documentCount: rows.filter((paper) => paper.submissionType === 'document').length,
        evaluatedCount: rows.filter((paper) => paper.aiStatus === 'evaluated').length,
        pendingEvaluationCount: rows.filter(
          (paper) => ['pending', 'processing'].includes(paper.aiStatus)
        ).length,
        averageScore: examScores.length
          ? Math.round(examScores.reduce((sum, score) => sum + score, 0) / examScores.length)
          : null,
        recommendedPaperId: recommendedId,
        approvedPaperId: approvedId,
        papers: rows,
      };
    });

    const pendingEvaluationPapers = papers.filter((paper) =>
      ['pending', 'processing'].includes(paperStatus(paper))
    );

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      module: 'Module B',
      generatedAt: new Date().toISOString(),
      stats: {
        exams: exams.length,
        papers: papers.length,
        evaluated: evaluatedPapers.length,
        pendingEvaluation: pendingEvaluationPapers.length,
        awaitingReview: papers.filter((paper) => paper.status === 'submitted').length,
        approved: papers.filter((paper) => paper.status === 'approved').length,
        averageScore,
        highestScore,
        submissionRate: exams.length
          ? Math.round((examRows.filter((exam) => exam.paperCount > 0).length / exams.length) * 100)
          : null,
      },
      scoreBands: {
        excellent: scores.filter((score) => score >= 85).length,
        good: scores.filter((score) => score >= 70 && score < 85).length,
        needsReview: scores.filter((score) => score < 70).length,
      },
      exams: examRows,
    });
  } catch (error) {
    return next(error);
  }
}

function requireHodDepartment(req) {
  const department = departmentOf(req);
  if (!department) throw new ApiError(403, 'Your account is not assigned to a department');
  return department;
}

async function createDepartmentExam(req, res, next) {
  try {
    const department = requireHodDepartment(req);
    const payload = validateExamPayload(req.body);
    const subject = await Subject.findOne({
      _id: payload.subjectId,
      department,
    });
    if (!subject) throw new ApiError(404, 'Subject not found in your department');

    const exam = await Exam.create({
      name: payload.name,
      subject: subject._id,
      type: payload.type,
      date: payload.date,
      startTime: payload.startTime,
      endTime: payload.endTime,
      room: payload.room,
      maxMarks: payload.maxMarks,
      passMarks: payload.passMarks,
      status: payload.status,
      notes: payload.notes,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await exam.populate('subject');

    return res.status(201).json({
      message: `${exam.name} scheduled for ${subject.code}.`,
      exam: scheduledExamDto(exam),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateDepartmentExam(req, res, next) {
  try {
    const department = requireHodDepartment(req);
    const { examId } = req.params;
    if (!mongoose.isValidObjectId(examId)) throw new ApiError(400, 'Invalid exam');

    const exam = await Exam.findById(examId).populate('subject');
    if (!exam) throw new ApiError(404, 'Exam not found');
    if (!exam.subject || exam.subject.department !== department) {
      throw new ApiError(404, 'Exam not found in your department');
    }

    const payload = validateExamPayload(req.body);
    const subject = await Subject.findOne({
      _id: payload.subjectId,
      department,
    });
    if (!subject) throw new ApiError(404, 'Subject not found in your department');

    exam.set({
      name: payload.name,
      subject: subject._id,
      type: payload.type,
      date: payload.date,
      startTime: payload.startTime,
      endTime: payload.endTime,
      room: payload.room,
      maxMarks: payload.maxMarks,
      passMarks: payload.passMarks,
      status: payload.status,
      notes: payload.notes,
      updatedBy: req.user._id,
    });
    await exam.save();
    await exam.populate('subject');

    return res.status(200).json({
      message: `${exam.name} updated.`,
      exam: scheduledExamDto(exam),
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteDepartmentExam(req, res, next) {
  try {
    const department = requireHodDepartment(req);
    const { examId } = req.params;
    if (!mongoose.isValidObjectId(examId)) throw new ApiError(400, 'Invalid exam');

    const exam = await Exam.findById(examId).populate('subject');
    if (!exam) throw new ApiError(404, 'Exam not found');
    if (!exam.subject || exam.subject.department !== department) {
      throw new ApiError(404, 'Exam not found in your department');
    }

    await exam.deleteOne();
    return res.status(200).json({ message: `${exam.name} removed.` });
  } catch (error) {
    return next(error);
  }
}

async function reports(req, res, next) {
  try {
    const now = new Date();
    const department = departmentOf(req);
    const [subjects, users] = await Promise.all([
      Subject.find(departmentFilter(req)).sort({ semester: 1, code: 1 }).lean(),
      User.find(departmentFilter(req)).select('name email role enrollmentId isActive').lean(),
    ]);

    const subjectById = new Map(subjects.map((subject) => [subject._id.toString(), subject]));
    const facultyById = new Map(
      users.filter((user) => user.role === 'faculty').map((user) => [user._id.toString(), user])
    );
    const activeStudents = users.filter((user) => user.role === 'student' && user.isActive);
    const studentsByBatch = new Map();

    for (const student of activeStudents) {
      const batch = batchForEnrollment(student.enrollmentId);
      if (!batch) continue;
      const bucket = studentsByBatch.get(batch) || [];
      bucket.push(student);
      studentsByBatch.set(batch, bucket);
    }

    const sessions = await loadSubjectSessions(subjects.map((subject) => subject._id));
    const sessionIds = sessions.map((session) => session._id);

    const [attachments, attendance, accesses, reminders] = await Promise.all([
      sessionIds.length
        ? Attachment.find({ session: { $in: sessionIds } })
            .select('session originalName')
            .lean()
        : [],
      sessionIds.length
        ? Attendance.find({ session: { $in: sessionIds } })
            .select('session student status')
            .lean()
        : [],
      sessionIds.length
        ? MaterialAccess.find({ session: { $in: sessionIds } })
            .select('session attachment student downloads previews lastAccessedAt')
            .lean()
        : [],
      sessionIds.length
        ? Notification.find({ type: 'material_reminder', session: { $in: sessionIds } })
            .select('session createdAt readAt')
            .sort({ createdAt: -1 })
            .lean()
        : [],
    ]);

    const attachmentCountBySession = new Map();
    for (const attachment of attachments) {
      const key = attachment.session.toString();
      attachmentCountBySession.set(
        key,
        (attachmentCountBySession.get(key) || 0) + 1
      );
    }

    const absentBySession = new Map();
    for (const record of attendance) {
      if (record.status !== 'absent') continue;
      const key = record.session.toString();
      const bucket = absentBySession.get(key) || new Set();
      bucket.add(record.student.toString());
      absentBySession.set(key, bucket);
    }

    const accessBySession = new Map();
    for (const access of accesses) {
      const key = access.session.toString();
      const bucket = accessBySession.get(key) || [];
      bucket.push(access);
      accessBySession.set(key, bucket);
    }

    const latestReminderBySession = new Map();
    for (const reminder of reminders) {
      const key = reminder.session?.toString();
      if (key && !latestReminderBySession.has(key)) {
        latestReminderBySession.set(key, reminder);
      }
    }

    const subjectMetrics = new Map(
      subjects.map((subject) => [
        subject._id.toString(),
        {
          subject,
          sessions: 0,
          published: 0,
          pending: 0,
          overdue: 0,
          turnaround: [],
          exposures: 0,
          accessed: 0,
          eligibleStudents: new Set(),
          accessingStudents: new Set(),
        },
      ])
    );

    const turnaroundSamples = [];
    const overdueNotes = [];
    const recentMaterials = [];
    const eligibleStudentIds = new Set();
    const accessingStudentIds = new Set();
    let exposures = 0;
    let accessed = 0;

    for (const session of sessions) {
      const subjectId = session.subject?.toString();
      const subject = subjectById.get(subjectId);
      if (!subject) continue;

      const metrics = subjectMetrics.get(subjectId);
      const attachmentCount = attachmentCountBySession.get(session._id.toString()) || 0;
      const isPublished = publishedMaterial(session);
      const end = sessionEnd(session);
      const dueAt = end ? new Date(end.getTime() + MATERIAL_SLA_HOURS * HOUR_MS) : null;
      const publishedAt = session.material?.uploadedAt
        ? new Date(session.material.uploadedAt)
        : null;
      const turnaround = isPublished && end && publishedAt ? hoursBetween(end, publishedAt) : null;
      const overdue = !isPublished && dueAt && dueAt < now;
      const overdueHours = overdue ? (now.getTime() - dueAt.getTime()) / HOUR_MS : 0;
      const faculty = subject.faculty ? facultyById.get(subject.faculty.toString()) : null;
      const reminder = latestReminderBySession.get(session._id.toString());

      metrics.sessions += 1;

      if (isPublished) metrics.published += 1;
      else metrics.pending += 1;
      if (overdue) metrics.overdue += 1;

      if (turnaround !== null) {
        metrics.turnaround.push(turnaround);
        turnaroundSamples.push(turnaround);
        recentMaterials.push({
          sessionId: session._id.toString(),
          subjectCode: session.courseCode,
          subjectName: subject.name,
          topic: session.topic,
          facultyName: faculty?.name || session.facultyName,
          uploadedAt: publishedAt.toISOString(),
          turnaroundHours: roundHours(turnaround),
          withinSla: turnaround <= MATERIAL_SLA_HOURS,
          attachmentCount,
        });
      }

      if (overdue) {
        overdueNotes.push({
          sessionId: session._id.toString(),
          subjectId,
          subjectCode: session.courseCode,
          subjectName: subject.name,
          topic: session.topic,
          date: session.date.toISOString(),
          startTime: session.startTime,
          endTime: session.endTime,
          dueAt: dueAt.toISOString(),
          overdueHours: roundHours(overdueHours),
          faculty: faculty
            ? { id: faculty._id.toString(), name: faculty.name, email: faculty.email }
            : { id: null, name: session.facultyName, email: null },
          reminderSentAt: reminder?.createdAt
            ? new Date(reminder.createdAt).toISOString()
            : null,
        });
      }

      if (!isPublished || !attachmentCount) continue;

      const visibility = session.material?.visibility || 'absent';
      const eligible =
        visibility === 'all'
          ? new Set((studentsByBatch.get(subject.batch) || []).map((student) => student._id.toString()))
          : new Set(absentBySession.get(session._id.toString()) || []);

      for (const studentId of eligible) {
        metrics.eligibleStudents.add(studentId);
        eligibleStudentIds.add(studentId);
      }

      const sessionExposures = eligible.size * attachmentCount;
      const sessionAccesses = (accessBySession.get(session._id.toString()) || []).filter(
        (access) => eligible.has(access.student.toString())
      );
      const sessionStudents = new Set(
        sessionAccesses.map((access) => access.student.toString())
      );

      for (const studentId of sessionStudents) {
        metrics.accessingStudents.add(studentId);
        accessingStudentIds.add(studentId);
      }

      metrics.exposures += sessionExposures;
      metrics.accessed += sessionAccesses.length;
      exposures += sessionExposures;
      accessed += sessionAccesses.length;
    }

    const samples = turnaroundSamples.length;
    const averageHours = samples
      ? turnaroundSamples.reduce((sum, value) => sum + value, 0) / samples
      : null;
    const withinSla = turnaroundSamples.filter((value) => value <= MATERIAL_SLA_HOURS).length;
    const bySubject = [...subjectMetrics.values()].map((metrics) => ({
      id: metrics.subject._id.toString(),
      code: metrics.subject.code,
      name: metrics.subject.name,
      faculty: metrics.subject.faculty
        ? facultyById.get(metrics.subject.faculty.toString())?.name || null
        : null,
      sessions: metrics.sessions,
      published: metrics.published,
      pending: metrics.pending,
      overdue: metrics.overdue,
      averageTurnaroundHours: metrics.turnaround.length
        ? roundHours(
            metrics.turnaround.reduce((sum, value) => sum + value, 0) /
              metrics.turnaround.length
          )
        : null,
      access: accessSummary(
        metrics.exposures,
        metrics.accessed,
        metrics.eligibleStudents.size,
        metrics.accessingStudents.size
      ),
    }));

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      department,
      slaHours: MATERIAL_SLA_HOURS,
      generatedAt: now.toISOString(),
      summary: {
        publishedSessions: sessions.filter((session) => publishedMaterial(session)).length,
        pendingSessions: sessions.filter((session) => !publishedMaterial(session)).length,
        turnaround: {
          samples,
          averageHours: roundHours(averageHours),
          medianHours: roundHours(median(turnaroundSamples)),
          withinSla,
          withinSlaRate: samples ? Math.round((withinSla / samples) * 100) : null,
          overdue: turnaroundSamples.filter((value) => value > MATERIAL_SLA_HOURS).length,
          fastestHours: samples ? roundHours(Math.min(...turnaroundSamples)) : null,
          slowestHours: samples ? roundHours(Math.max(...turnaroundSamples)) : null,
        },
        overdueNotes: overdueNotes.length,
        access: accessSummary(
          exposures,
          accessed,
          eligibleStudentIds.size,
          accessingStudentIds.size
        ),
      },
      turnaround: {
        recent: recentMaterials
          .sort((first, second) => new Date(second.uploadedAt) - new Date(first.uploadedAt))
          .slice(0, 8),
        bySubject,
      },
      overdueNotes: overdueNotes.sort(
        (first, second) => new Date(first.dueAt) - new Date(second.dueAt)
      ),
      access: {
        summary: accessSummary(
          exposures,
          accessed,
          eligibleStudentIds.size,
          accessingStudentIds.size
        ),
        bySubject,
        trackedDownloads: accesses.reduce((sum, access) => sum + (access.downloads || 0), 0),
        trackedPreviews: accesses.reduce((sum, access) => sum + (access.previews || 0), 0),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function sendMaterialReminder(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!mongoose.isValidObjectId(sessionId)) throw new ApiError(400, 'Invalid session');

    const session = await Session.findById(sessionId).populate('subject');
    if (!session || !session.subject) throw new ApiError(404, 'Class session not found');

    const department = departmentOf(req);
    if (!department || session.subject.department !== department) {
      throw new ApiError(404, 'Class session not found in your department');
    }

    if (publishedMaterial(session)) {
      throw new ApiError(400, 'Material is already published for this session');
    }

    const faculty = await User.findOne({
      _id: session.subject.faculty,
      role: 'faculty',
      isActive: true,
      department,
    }).lean();

    if (!faculty) {
      throw new ApiError(400, 'This class has no active responsible faculty member');
    }

    const notification = await Notification.create({
      recipient: faculty._id,
      actor: req.user._id,
      type: 'material_reminder',
      title: `Material reminder · ${session.courseCode}`,
      message: `${req.user.name} asked you to publish learning material for ${session.courseCode} · ${session.topic} (${formatSessionDate(session.date)}). Students in the subject's batch are waiting.`,
      session: session._id,
      subject: session.subject._id,
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(201).json({
      message: `Reminder sent to ${faculty.name}.`,
      reminder: {
        id: notification._id.toString(),
        sentAt: notification.createdAt.toISOString(),
      },
      faculty: { id: faculty._id.toString(), name: faculty.name, email: faculty.email },
    });
  } catch (error) {
    return next(error);
  }
}

function formatSessionDate(value) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

module.exports = {
  overview,
  facultyList,
  subjects,
  subjectSessions,
  assignFaculty,
  attendanceOverview,
  examinations,
  createDepartmentExam,
  updateDepartmentExam,
  deleteDepartmentExam,
  reports,
  sendMaterialReminder,
};
