const mongoose = require('mongoose');
const User = require('../models/User');
const Subject = require('../models/Subject');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const Exam = require('../models/Exam');
const QuestionPaper = require('../models/QuestionPaper');
const SubjectPlan = require('../models/SubjectPlan');
const AuditLog = require('../models/AuditLog');
const SystemIntegration = require('../models/SystemIntegration');
const { ApiError } = require('../middleware/errorHandler');

const ROLE_LABELS = {
  student: 'Student',
  faculty: 'Faculty',
  hod: 'HOD / Dept Admin',
  exam_cell: 'Examination Cell',
  academic_admin: 'Academic Admin',
  super_admin: 'Super Admin',
};

const PRIVILEGED_ROLES = new Set(['academic_admin', 'super_admin']);
const MAX_PLAN_UNITS = 25;
const MAX_PLAN_COMPONENTS = 10;
const MAX_PLAN_TOTAL = 2000;

const DEFAULT_INTEGRATIONS = [
  {
    key: 'erp',
    name: 'ERP master data',
    description:
      'Student, faculty, programme and department master records from the institutional ERP.',
  },
  {
    key: 'sis',
    name: 'SIS master data',
    description:
      'Enrollment, academic-year, batch and registration master records from the student information system.',
  },
];

function isSuper(actor) {
  return actor.role === 'super_admin';
}

function assertSuper(actor) {
  if (!isSuper(actor)) throw new ApiError(403, 'Only a super admin can manage system settings');
}

function rate(present, marked) {
  return marked ? Math.round((present / marked) * 100) : null;
}

function countAttendance(records) {
  const counts = { present: 0, absent: 0, late: 0, marked: records.length };
  for (const record of records) {
    if (record.status === 'present') counts.present += 1;
    else if (record.status === 'absent') counts.absent += 1;
    else if (record.status === 'late') counts.late += 1;
  }
  counts.rate = rate(counts.present, counts.marked);
  return counts;
}

function subjectDto(subject, faculty) {
  return {
    id: subject._id.toString(),
    code: subject.code,
    name: subject.name,
    department: subject.department,
    semester: subject.semester,
    academicYear: subject.academicYear,
    batch: subject.batch,
    section: subject.section,
    faculty: faculty
      ? {
          id: faculty._id.toString(),
          name: faculty.name,
          email: faculty.email,
        }
      : null,
  };
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
    status: exam.status,
    subject: exam.subject
      ? {
          id: exam.subject._id.toString(),
          code: exam.subject.code,
          name: exam.subject.name,
          batch: exam.subject.batch,
        }
      : null,
  };
}

function planDto(plan) {
  if (!plan) {
    return {
      syllabus: [],
      components: [],
      notes: '',
      totalMarks: 0,
      updatedAt: null,
    };
  }

  return {
    syllabus: (plan.syllabus || []).map((unit) => ({
      title: unit.title,
      topics: unit.topics || '',
    })),
    components: (plan.components || []).map((component) => ({
      name: component.name,
      maxMarks: component.maxMarks,
    })),
    notes: plan.notes || '',
    totalMarks: (plan.components || []).reduce(
      (sum, component) => sum + (component.maxMarks || 0),
      0
    ),
    updatedAt: plan.updatedAt ? plan.updatedAt.toISOString() : null,
  };
}

function parseSubjectPayload(body) {
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  const department = String(body.department || '').trim();
  const academicYear = String(body.academicYear || '').trim();
  const batch = String(body.batch || '').trim();
  const section = String(body.section || '').trim().toUpperCase();
  const semester = Number(body.semester);
  const facultyId = String(body.facultyId || '').trim();

  if (!/^[A-Z0-9-]{2,16}$/.test(code)) {
    throw new ApiError(400, 'Subject code must be 2–16 letters, numbers or hyphens');
  }
  if (!name || name.length > 160) {
    throw new ApiError(400, 'Subject name is required and must be 160 characters or fewer');
  }
  if (!department || department.length > 120) {
    throw new ApiError(400, 'Department is required and must be 120 characters or fewer');
  }
  if (!Number.isInteger(semester) || semester < 1 || semester > 12) {
    throw new ApiError(400, 'Semester must be a whole number from 1 to 12');
  }
  if (!/^\d{4}-\d{2}$/.test(academicYear)) {
    throw new ApiError(400, 'Academic year must look like 2026-27');
  }
  if (!/^\d{4}-\d{4}$/.test(batch)) {
    throw new ApiError(400, 'Batch must look like 2024-2028');
  }
  if (!section || section.length > 8) {
    throw new ApiError(400, 'Section is required and must be 8 characters or fewer');
  }
  if (facultyId && !mongoose.isValidObjectId(facultyId)) {
    throw new ApiError(400, 'Select a valid faculty member');
  }

  return {
    code,
    name,
    department,
    semester,
    academicYear,
    batch,
    section,
    facultyId: facultyId || null,
  };
}

async function resolveFaculty(facultyId, department) {
  if (!facultyId) return null;

  const faculty = await User.findOne({
    _id: facultyId,
    role: 'faculty',
    isActive: true,
  }).lean();

  if (!faculty) throw new ApiError(400, 'Select an active faculty account');
  if (faculty.department !== department) {
    throw new ApiError(400, 'Faculty must belong to the subject department');
  }

  return faculty;
}

async function assertUniqueSubject(payload, subjectId = null) {
  const duplicate = await Subject.findOne({
    code: payload.code,
    academicYear: payload.academicYear,
    section: payload.section,
    ...(subjectId ? { _id: { $ne: subjectId } } : {}),
  }).lean();

  if (duplicate) {
    throw new ApiError(409, 'A subject with that code, academic year and section already exists');
  }
}

function parseRequirementsPayload(body) {
  const syllabus = Array.isArray(body.syllabus) ? body.syllabus : [];
  const components = Array.isArray(body.components) ? body.components : [];
  const notes = String(body.notes || '').trim();

  if (syllabus.length > MAX_PLAN_UNITS) {
    throw new ApiError(400, `A syllabus can have at most ${MAX_PLAN_UNITS} units`);
  }
  if (components.length > MAX_PLAN_COMPONENTS) {
    throw new ApiError(400, `A marks scheme can have at most ${MAX_PLAN_COMPONENTS} components`);
  }
  if (notes.length > 1000) throw new ApiError(400, 'Notes must be 1000 characters or fewer');

  const units = syllabus.map((unit, index) => {
    const title = String(unit.title || '').trim();
    const topics = String(unit.topics || '').trim();

    if (!title) throw new ApiError(400, `Unit ${index + 1} needs a title`);
    if (title.length > 160) throw new ApiError(400, `Unit ${index + 1} title is too long`);
    if (topics.length > 3000) throw new ApiError(400, `Unit ${index + 1} topics are too long`);

    return { title, topics };
  });

  const names = new Set();
  let total = 0;
  const marks = components.map((component, index) => {
    const name = String(component.name || '').trim();
    const maxMarks = Number(component.maxMarks);

    if (!name) throw new ApiError(400, `Component ${index + 1} needs a name`);
    if (name.length > 80) throw new ApiError(400, `Component ${index + 1} name is too long`);
    if (!Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > 1000) {
      throw new ApiError(400, `Component ${index + 1} marks must be a whole number from 1 to 1000`);
    }

    const key = name.toLowerCase();
    if (names.has(key)) throw new ApiError(400, `Duplicate component "${name}"`);
    names.add(key);
    total += maxMarks;

    return { name, maxMarks };
  });

  if (total > MAX_PLAN_TOTAL) {
    throw new ApiError(400, `The total marks cannot exceed ${MAX_PLAN_TOTAL}`);
  }

  return { syllabus: units, components: marks, notes };
}

async function audit(actor, action, target, detail) {
  await AuditLog.create({
    action,
    actor: actor._id,
    actorName: actor.name,
    target: target?._id || null,
    targetName: target?.name || '',
    detail: detail || '',
  });
}

async function overview(req, res, next) {
  try {
    const [users, subjects, sessions, attendance, exams, papers] = await Promise.all([
      User.find({}).select('name email role department enrollmentId isActive lastLoginAt createdAt').lean(),
      Subject.find({}).lean(),
      Session.find({}).select('subject courseCode courseName date material').lean(),
      Attendance.find({}).select('session student status').lean(),
      Exam.find({}).populate('subject').sort({ date: 1 }).lean(),
      QuestionPaper.find({}).select('exam status evaluation.total').lean(),
    ]);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const activeUsers = users.filter((user) => user.isActive);
    const upcoming = exams.filter((exam) => exam.date >= today && exam.status === 'scheduled');
    const attendanceTotals = countAttendance(attendance);
    const materialCount = sessions.filter((session) => session.material?.title).length;

    const roles = Object.keys(ROLE_LABELS).map((role) => ({
      role,
      label: ROLE_LABELS[role],
      count: users.filter((user) => user.role === role).length,
      active: activeUsers.filter((user) => user.role === role).length,
    }));

    const departments = [...new Set([...users.map((user) => user.department), ...subjects.map((subject) => subject.department)].filter(Boolean))]
      .sort();

    const departmentRows = departments
      .map((department) => {
        const departmentSubjects = subjects.filter(
          (subject) => subject.department === department
        );
        const subjectIds = new Set(departmentSubjects.map((subject) => subject._id.toString()));
        const departmentSessions = sessions.filter((session) =>
          session.subject ? subjectIds.has(session.subject.toString()) : false
        );
        const sessionIds = new Set(departmentSessions.map((session) => session._id.toString()));
        const departmentAttendance = attendance.filter((record) =>
          sessionIds.has(record.session.toString())
        );
        const counts = countAttendance(departmentAttendance);

        return {
          department,
          students: activeUsers.filter(
            (user) => user.role === 'student' && user.department === department
          ).length,
          faculty: activeUsers.filter(
            (user) => user.role === 'faculty' && user.department === department
          ).length,
          subjects: departmentSubjects.length,
          sessions: departmentSessions.length,
          attendanceRate: counts.rate,
        };
      })
      .filter((row) => row.subjects > 0 || row.students > 0 || row.faculty > 0);

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      scope: isSuper(req.user) ? 'institution' : 'academic',
      stats: {
        users: users.length,
        activeUsers: activeUsers.length,
        inactiveUsers: users.length - activeUsers.length,
        students: activeUsers.filter((user) => user.role === 'student').length,
        faculty: activeUsers.filter((user) => user.role === 'faculty').length,
        subjects: subjects.length,
        sessions: sessions.length,
        materials: materialCount,
        pendingMaterials: sessions.length - materialCount,
        exams: exams.length,
        upcomingExams: upcoming.length,
        attendanceRate: attendanceTotals.rate,
        present: attendanceTotals.present,
        absent: attendanceTotals.absent,
        marked: attendanceTotals.marked,
        papers: papers.length,
        approvedPapers: papers.filter((paper) => paper.status === 'approved').length,
        pendingPapers: papers.filter((paper) => paper.status === 'submitted').length,
        averagePaperScore: papers.length
          ? Math.round(
              papers.reduce((sum, paper) => sum + (paper.evaluation?.total || 0), 0) /
                papers.length
            )
          : 0,
      },
      roles,
      departments: departmentRows,
      upcomingExams: upcoming.slice(0, 6).map(examDto),
      recentUsers: [...users]
        .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
        .slice(0, 5)
        .map((user) => ({
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          isActive: user.isActive,
          createdAt: user.createdAt.toISOString(),
        })),
    });
  } catch (error) {
    return next(error);
  }
}

async function listUsers(req, res, next) {
  try {
    const { role, status, q } = req.query;
    const filter = {};

    if (role) {
      if (!ROLE_LABELS[role]) throw new ApiError(400, 'Invalid role filter');
      filter.role = role;
    }
    if (status === 'active') filter.isActive = true;
    else if (status === 'inactive') filter.isActive = false;
    else if (status) throw new ApiError(400, 'Invalid status filter');

    const users = await User.find(filter)
      .select('name email role department enrollmentId isActive lastLoginAt createdAt')
      .sort({ name: 1 })
      .lean();

    const [subjects, sessions, attendance] = await Promise.all([
      Subject.find({}).select('faculty').lean(),
      Session.find({}).select('subject').lean(),
      Attendance.find({}).select('student status').lean(),
    ]);

    const subjectIdsByFaculty = new Map();
    for (const subject of subjects) {
      if (!subject.faculty) continue;
      const key = subject.faculty.toString();
      const list = subjectIdsByFaculty.get(key) || [];
      list.push(subject._id.toString());
      subjectIdsByFaculty.set(key, list);
    }

    const sessionCountBySubject = new Map();
    for (const session of sessions) {
      if (!session.subject) continue;
      const key = session.subject.toString();
      sessionCountBySubject.set(key, (sessionCountBySubject.get(key) || 0) + 1);
    }

    const attendanceByStudent = new Map();
    for (const record of attendance) {
      const key = record.student.toString();
      const bucket = attendanceByStudent.get(key) || { present: 0, marked: 0 };
      bucket.marked += 1;
      if (record.status === 'present') bucket.present += 1;
      attendanceByStudent.set(key, bucket);
    }

    let rows = users.map((user) => {
      const base = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        roleLabel: ROLE_LABELS[user.role],
        department: user.department,
        enrollmentId: user.enrollmentId,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
        createdAt: user.createdAt.toISOString(),
      };

      if (user.role === 'faculty' || user.role === 'hod') {
        const owned = subjectIdsByFaculty.get(user._id.toString()) || [];
        base.subjectCount = owned.length;
        base.sessionCount = owned.reduce(
          (sum, subjectId) => sum + (sessionCountBySubject.get(subjectId) || 0),
          0
        );
      }

      if (user.role === 'student') {
        const bucket = attendanceByStudent.get(user._id.toString());
        base.attendanceRate = bucket ? rate(bucket.present, bucket.marked) : null;
        base.sessionsMarked = bucket?.marked || 0;
      }

      return base;
    });

    if (q) {
      const needle = String(q).trim().toLowerCase();
      rows = rows.filter(
        (user) =>
          user.name.toLowerCase().includes(needle) ||
          user.email.toLowerCase().includes(needle) ||
          (user.enrollmentId || '').toLowerCase().includes(needle)
      );
    }

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      users: rows,
      roles: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
    });
  } catch (error) {
    return next(error);
  }
}

async function academics(req, res, next) {
  try {
    const [subjects, faculty, sessions, attendance, exams, papers, plans] = await Promise.all([
      Subject.find({}).sort({ department: 1, semester: 1, code: 1 }).lean(),
      User.find({ role: 'faculty', isActive: true }).select('name email department').lean(),
      Session.find({}).select('subject material').lean(),
      Attendance.find({}).select('session student status').lean(),
      Exam.find({}).populate('subject').sort({ date: 1 }).lean(),
      QuestionPaper.find({}).select('exam status').lean(),
      SubjectPlan.find({}).select('subject syllabus components notes updatedAt').lean(),
    ]);

    const facultyById = new Map(faculty.map((member) => [member._id.toString(), member]));
    const planBySubject = new Map(plans.map((plan) => [plan.subject.toString(), plan]));
    const paperCountByExam = new Map();
    for (const paper of papers) {
      const key = paper.exam.toString();
      paperCountByExam.set(key, (paperCountByExam.get(key) || 0) + 1);
    }

    const subjectRows = subjects.map((subject) => {
      const ownedSessions = sessions.filter(
        (session) => session.subject?.toString() === subject._id.toString()
      );
      const sessionIds = new Set(ownedSessions.map((session) => session._id.toString()));
      const records = attendance.filter((record) => sessionIds.has(record.session.toString()));
      const counts = countAttendance(records);
      const plan = planBySubject.get(subject._id.toString());

      return {
        ...subjectDto(subject, facultyById.get(subject.faculty?.toString())),
        sessionCount: ownedSessions.length,
        materialCount: ownedSessions.filter((session) => session.material?.title).length,
        studentCount: new Set(records.map((record) => record.student.toString())).size,
        attendance: {
          present: counts.present,
          absent: counts.absent,
          late: counts.late,
          marked: counts.marked,
          rate: counts.rate,
        },
        examCount: exams.filter(
          (exam) => exam.subject?._id?.toString() === subject._id.toString()
        ).length,
        boardUnits: plan?.syllabus?.length || 0,
        planMarks: (plan?.components || []).reduce(
          (sum, component) => sum + (component.maxMarks || 0),
          0
        ),
        plan: planDto(plan),
      };
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      subjects: subjectRows,
      exams: exams.map((exam) => ({
        ...examDto(exam),
        paperCount: paperCountByExam.get(exam._id.toString()) || 0,
      })),
      faculty: faculty.map((member) => ({
        id: member._id.toString(),
        name: member.name,
        email: member.email,
        department: member.department,
      })),
      departments: [...new Set(subjects.map((subject) => subject.department))].sort(),
      summary: {
        subjects: subjects.length,
        assigned: subjects.filter((subject) => subject.faculty).length,
        unassigned: subjects.filter((subject) => !subject.faculty).length,
        withBoardSyllabus: plans.filter((plan) => (plan.syllabus?.length || 0) > 0).length,
        withExamRequirements: plans.filter(
          (plan) =>
            (plan.syllabus?.length || 0) > 0 || (plan.components?.length || 0) > 0
        ).length,
        exams: exams.length,
        upcomingExams: exams.filter((exam) => exam.status === 'scheduled').length,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createSubject(req, res, next) {
  try {
    const payload = parseSubjectPayload(req.body);
    await assertUniqueSubject(payload);
    const faculty = await resolveFaculty(payload.facultyId, payload.department);

    const subject = await Subject.create({
      code: payload.code,
      name: payload.name,
      department: payload.department,
      semester: payload.semester,
      academicYear: payload.academicYear,
      batch: payload.batch,
      section: payload.section,
      faculty: faculty?._id || null,
    });

    await audit(
      req.user,
      'subject.created',
      null,
      `${subject.code} · ${subject.name} · ${subject.department}`
    );

    return res.status(201).json({
      message: `${subject.code} added to the subject catalogue.`,
      subject: subjectDto(subject, faculty),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateSubject(req, res, next) {
  try {
    const { subjectId } = req.params;
    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findById(subjectId);
    if (!subject) throw new ApiError(404, 'Subject not found');

    const payload = parseSubjectPayload(req.body);
    await assertUniqueSubject(payload, subject._id);
    const faculty = await resolveFaculty(payload.facultyId, payload.department);
    const previousCode = subject.code;

    subject.set({
      code: payload.code,
      name: payload.name,
      department: payload.department,
      semester: payload.semester,
      academicYear: payload.academicYear,
      batch: payload.batch,
      section: payload.section,
      faculty: faculty?._id || null,
    });
    await subject.save();

    await Session.updateMany(
      { subject: subject._id },
      {
        $set: {
          courseCode: subject.code,
          courseName: subject.name,
          department: subject.department,
          semester: subject.semester,
          facultyName: faculty?.name || 'Unassigned',
        },
      }
    );

    await audit(
      req.user,
      'subject.updated',
      null,
      `${previousCode} updated to ${subject.code} · ${subject.name}`
    );

    return res.status(200).json({
      message: `${subject.code} updated.`,
      subject: subjectDto(subject, faculty),
    });
  } catch (error) {
    return next(error);
  }
}

async function assignSubjectFaculty(req, res, next) {
  try {
    const { subjectId } = req.params;
    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findById(subjectId);
    if (!subject) throw new ApiError(404, 'Subject not found');

    const faculty = await resolveFaculty(
      String(req.body?.facultyId || '').trim(),
      subject.department
    );
    if (!faculty) throw new ApiError(400, 'Select an active faculty member');

    subject.faculty = faculty._id;
    await subject.save();
    await Session.updateMany(
      { subject: subject._id },
      { $set: { facultyName: faculty.name } }
    );

    await audit(
      req.user,
      'subject.faculty_assigned',
      null,
      `${subject.code} assigned to ${faculty.name}`
    );

    return res.status(200).json({
      message: `${subject.code} assigned to ${faculty.name}.`,
      subject: subjectDto(subject, faculty),
    });
  } catch (error) {
    return next(error);
  }
}

async function saveSubjectRequirements(req, res, next) {
  try {
    const { subjectId } = req.params;
    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findById(subjectId).lean();
    if (!subject) throw new ApiError(404, 'Subject not found');

    const payload = parseRequirementsPayload(req.body);
    const plan = await SubjectPlan.findOneAndUpdate(
      { subject: subject._id },
      {
        $set: {
          syllabus: payload.syllabus,
          components: payload.components,
          notes: payload.notes,
          updatedBy: req.user._id,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await audit(
      req.user,
      'subject.requirements_updated',
      null,
      `${subject.code} · ${payload.syllabus.length} units · ${payload.components.length} components`
    );

    return res.status(200).json({
      message: `Examination requirements saved for ${subject.code}.`,
      subjectId: subject._id.toString(),
      plan: planDto(plan),
    });
  } catch (error) {
    return next(error);
  }
}

function integrationDto(integration) {
  return {
    key: integration.key,
    name: integration.name,
    description: integration.description,
    endpoint: integration.endpoint || '',
    enabled: integration.enabled,
    syncFrequencyMinutes: integration.syncFrequencyMinutes,
    status: integration.status,
    lastCheckedAt: integration.lastCheckedAt
      ? integration.lastCheckedAt.toISOString()
      : null,
    lastError: integration.lastError || '',
    notes: integration.notes || '',
    updatedAt: integration.updatedAt ? integration.updatedAt.toISOString() : null,
  };
}

async function ensureIntegrations() {
  const rows = [];

  for (const definition of DEFAULT_INTEGRATIONS) {
    rows.push(
      await SystemIntegration.findOneAndUpdate(
        { key: definition.key },
        {
          $setOnInsert: {
            ...definition,
            endpoint: '',
            enabled: false,
            syncFrequencyMinutes: 60,
            status: 'not_configured',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
    );
  }

  return rows;
}

async function systemSettings(req, res, next) {
  try {
    assertSuper(req.user);
    const integrations = await ensureIntegrations();
    const [students, faculty, subjects, departments] = await Promise.all([
      User.countDocuments({ role: 'student', isActive: true }),
      User.countDocuments({ role: 'faculty', isActive: true }),
      Subject.countDocuments({}),
      Subject.distinct('department'),
    ]);

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      integrations: integrations.map(integrationDto),
      masterData: {
        students,
        faculty,
        subjects,
        departments: departments.length,
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
}

function validateIntegrationEndpoint(endpoint) {
  if (!endpoint) return '';

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ApiError(400, 'Enter a valid ERP or SIS endpoint URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(400, 'Integration endpoints must use http:// or https://');
  }

  return parsed.toString();
}

async function updateSystemIntegration(req, res, next) {
  try {
    assertSuper(req.user);
    const key = String(req.params.key || '').toLowerCase();
    if (!DEFAULT_INTEGRATIONS.some((item) => item.key === key)) {
      throw new ApiError(400, 'Unknown integration');
    }

    await ensureIntegrations();
    const integration = await SystemIntegration.findOne({ key });
    if (!integration) throw new ApiError(404, 'Integration not found');

    const endpoint = validateIntegrationEndpoint(String(req.body?.endpoint || '').trim());
    const enabled = req.body?.enabled === true;
    const syncFrequencyMinutes = Number(req.body?.syncFrequencyMinutes);
    const notes = String(req.body?.notes || '').trim();

    if (!Number.isInteger(syncFrequencyMinutes) || syncFrequencyMinutes < 5 || syncFrequencyMinutes > 10080) {
      throw new ApiError(400, 'Sync frequency must be a whole number from 5 to 10080 minutes');
    }
    if (notes.length > 1000) throw new ApiError(400, 'Notes must be 1000 characters or fewer');
    if (enabled && !endpoint) {
      throw new ApiError(400, 'Add an endpoint before enabling this connection');
    }

    const endpointChanged = endpoint !== integration.endpoint;
    integration.endpoint = endpoint;
    integration.enabled = enabled;
    integration.syncFrequencyMinutes = syncFrequencyMinutes;
    integration.notes = notes;
    integration.updatedBy = req.user._id;

    if (!enabled) integration.status = 'disabled';
    else if (!endpoint) integration.status = 'not_configured';
    else if (endpointChanged || ['not_configured', 'disabled'].includes(integration.status)) {
      integration.status = 'unverified';
    }
    if (endpointChanged) integration.lastError = '';
    await integration.save();

    await audit(
      req.user,
      'system.integration_updated',
      null,
      `${integration.name} · ${enabled ? 'enabled' : 'disabled'} · ${endpoint || 'no endpoint'}`
    );

    return res.status(200).json({
      message: `${integration.name} configuration saved.`,
      integration: integrationDto(integration),
    });
  } catch (error) {
    return next(error);
  }
}

async function testSystemIntegration(req, res, next) {
  try {
    assertSuper(req.user);
    const key = String(req.params.key || '').toLowerCase();
    if (!DEFAULT_INTEGRATIONS.some((item) => item.key === key)) {
      throw new ApiError(400, 'Unknown integration');
    }

    await ensureIntegrations();
    const integration = await SystemIntegration.findOne({ key });
    if (!integration) throw new ApiError(404, 'Integration not found');
    if (!integration.endpoint) throw new ApiError(400, 'Add an endpoint before testing the connection');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let connected = false;
    let detail = '';

    try {
      let response = await fetch(integration.endpoint, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status === 405) {
        response = await fetch(integration.endpoint, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });
      }

      connected = response.status >= 200 && response.status < 400;
      detail = connected
        ? `Endpoint reachable with HTTP ${response.status}.`
        : `Endpoint responded with HTTP ${response.status}.`;
    } catch (error) {
      detail =
        error.name === 'AbortError'
          ? 'Connection test timed out after 6 seconds.'
          : `Connection failed: ${error.message}`.slice(0, 500);
    } finally {
      clearTimeout(timer);
    }

    integration.status = connected ? 'connected' : 'error';
    integration.lastCheckedAt = new Date();
    integration.lastError = connected ? '' : detail;
    integration.updatedBy = req.user._id;
    await integration.save();

    await audit(
      req.user,
      'system.integration_tested',
      null,
      `${integration.name} · ${connected ? 'connected' : 'failed'} · ${detail}`
    );

    return res.status(200).json({
      message: connected
        ? `${integration.name} connected successfully.`
        : `${integration.name} could not connect.`,
      integration: integrationDto(integration),
      detail,
    });
  } catch (error) {
    return next(error);
  }
}

async function activity(req, res, next) {
  try {
    if (!isSuper(req.user)) throw new ApiError(403, 'Only a super admin can view the audit trail');

    const logs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(40).lean();

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      activity: logs.map((log) => ({
        id: log._id.toString(),
        action: log.action,
        actorName: log.actorName,
        targetName: log.targetName,
        detail: log.detail,
        createdAt: log.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return next(error);
  }
}

function assertCanManage(actor, target) {
  if (actor._id.toString() === target._id.toString()) {
    throw new ApiError(400, 'You cannot change your own account');
  }

  if (!isSuper(actor) && PRIVILEGED_ROLES.has(target.role)) {
    throw new ApiError(403, 'Only a super admin can manage administrator accounts');
  }
}

async function setUserStatus(req, res, next) {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) throw new ApiError(400, 'Invalid account');

    if (typeof req.body?.isActive !== 'boolean') {
      throw new ApiError(400, 'isActive must be true or false');
    }

    const target = await User.findById(userId);
    if (!target) throw new ApiError(404, 'Account not found');

    assertCanManage(req.user, target);

    target.isActive = req.body.isActive;
    await target.save();

    await audit(
      req.user,
      target.isActive ? 'account.activated' : 'account.deactivated',
      target,
      `${ROLE_LABELS[target.role] || target.role} account ${target.isActive ? 'reactivated' : 'deactivated'}`
    );

    return res.status(200).json({
      message: `${target.name} ${target.isActive ? 'reactivated' : 'deactivated'}.`,
      user: {
        id: target._id.toString(),
        name: target.name,
        role: target.role,
        isActive: target.isActive,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function setUserRole(req, res, next) {
  try {
    if (!isSuper(req.user)) throw new ApiError(403, 'Only a super admin can change roles');

    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) throw new ApiError(400, 'Invalid account');

    const role = String(req.body?.role || '');
    if (!ROLE_LABELS[role]) throw new ApiError(400, 'Select a valid role');

    const target = await User.findById(userId);
    if (!target) throw new ApiError(404, 'Account not found');
    if (target._id.toString() === req.user._id.toString()) {
      throw new ApiError(400, 'You cannot change your own role');
    }
    if (target.role === role) {
      return res.status(200).json({ message: `${target.name} already has that role.` });
    }

    const previous = target.role;
    target.role = role;
    await target.save();

    await audit(
      req.user,
      'account.role_changed',
      target,
      `${ROLE_LABELS[previous]} → ${ROLE_LABELS[role]}`
    );

    return res.status(200).json({
      message: `${target.name} is now ${ROLE_LABELS[role]}.`,
      user: {
        id: target._id.toString(),
        name: target.name,
        role: target.role,
        isActive: target.isActive,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  overview,
  listUsers,
  academics,
  createSubject,
  updateSubject,
  assignSubjectFaculty,
  saveSubjectRequirements,
  systemSettings,
  updateSystemIntegration,
  testSystemIntegration,
  activity,
  setUserStatus,
  setUserRole,
};
