const mongoose = require('mongoose');
const Exam = require('../models/Exam');
const Subject = require('../models/Subject');
const SubjectPlan = require('../models/SubjectPlan');
const User = require('../models/User');
const { ApiError } = require('../middleware/errorHandler');

const MAX_UNITS = 25;
const MAX_COMPONENTS = 10;
const MAX_PLAN_TOTAL = 2000;

const TIME_RE = /^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i;

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

function examDto(exam) {
  const subject = exam.subject && exam.subject.code ? exam.subject : null;

  return {
    id: exam._id.toString(),
    name: exam.name,
    type: exam.type,
    date: exam.date.toISOString(),
    startTime: exam.startTime,
    endTime: exam.endTime,
    room: exam.room,
    maxMarks: exam.maxMarks,
    passMarks: exam.passMarks,
    status: exam.status,
    notes: exam.notes || '',
    subject: subject ? subjectDto(subject) : null,
    createdAt: exam.createdAt ? exam.createdAt.toISOString() : null,
    updatedAt: exam.updatedAt ? exam.updatedAt.toISOString() : null,
  };
}

function timeToMinutes(value) {
  const match = TIME_RE.exec(String(value || '').trim());
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3] ? match[3].toUpperCase() : null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours %= 12;
    if (meridiem === 'PM') hours += 12;
  }

  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseExamDate(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new ApiError(400, 'An exam date is required');

  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'Enter a valid exam date');
  }

  return date;
}

function parseMarks(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw new ApiError(400, `${field} must be a whole number`);
  }
  return number;
}

function validateExamPayload(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError(400, 'An exam name is required');
  if (name.length > 160) throw new ApiError(400, 'The exam name must be 160 characters or fewer');

  const subjectId = String(body.subjectId || '');
  if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Select a valid subject');

  const type = String(body.type || 'internal');
  if (!Exam.EXAM_TYPES.includes(type)) throw new ApiError(400, 'Select a valid exam type');

  const status = String(body.status || 'scheduled');
  if (!Exam.EXAM_STATUSES.includes(status)) throw new ApiError(400, 'Select a valid exam status');

  const date = parseExamDate(body.date);

  const startTime = String(body.startTime || '').trim();
  const endTime = String(body.endTime || '').trim();
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  if (startMinutes === null) throw new ApiError(400, 'Enter a valid start time (e.g. 09:00 or 09:00 AM)');
  if (endMinutes === null) throw new ApiError(400, 'Enter a valid end time (e.g. 11:00 or 11:00 AM)');
  if (endMinutes <= startMinutes) throw new ApiError(400, 'The end time must be after the start time');

  const room = String(body.room || '').trim();
  if (room.length > 80) throw new ApiError(400, 'The room must be 80 characters or fewer');

  const maxMarks = parseMarks(body.maxMarks, 'Maximum marks');
  if (maxMarks < 1 || maxMarks > 1000) {
    throw new ApiError(400, 'Maximum marks must be between 1 and 1000');
  }

  const passMarks = parseMarks(body.passMarks ?? 0, 'Passing marks');
  if (passMarks < 0) throw new ApiError(400, 'Passing marks cannot be negative');
  if (passMarks > maxMarks) {
    throw new ApiError(400, 'Passing marks cannot be greater than the maximum marks');
  }

  const notes = String(body.notes || '').trim();
  if (notes.length > 1000) throw new ApiError(400, 'Notes must be 1000 characters or fewer');

  return {
    name,
    subjectId,
    type,
    status,
    date,
    startTime,
    endTime,
    room: room || null,
    maxMarks,
    passMarks,
    notes,
  };
}

async function resolveSubject(subjectId) {
  const subject = await Subject.findById(subjectId).lean();
  if (!subject) throw new ApiError(404, 'Subject not found');
  return subject;
}

async function overview(req, res, next) {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const [subjects, exams, plans] = await Promise.all([
      Subject.find({}).sort({ department: 1, semester: 1, code: 1 }).lean(),
      Exam.find({}).populate('subject').sort({ date: 1 }).lean(),
      SubjectPlan.find({}).select('subject syllabus components updatedAt').lean(),
    ]);

    const planBySubject = new Map(
      plans.map((plan) => [plan.subject.toString(), plan])
    );

    const upcoming = exams.filter(
      (exam) => exam.date >= today && exam.status === 'scheduled'
    );

    const plannedSubjects = new Set(
      plans
        .filter((plan) => (plan.syllabus?.length || 0) > 0 || (plan.components?.length || 0) > 0)
        .map((plan) => plan.subject.toString())
    );

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      stats: {
        subjects: subjects.length,
        exams: exams.length,
        upcoming: upcoming.length,
        completed: exams.filter((exam) => exam.status === 'completed').length,
        cancelled: exams.filter((exam) => exam.status === 'cancelled').length,
        subjectsWithPlan: plannedSubjects.size,
        subjectsWithoutPlan: Math.max(subjects.length - plannedSubjects.size, 0),
      },
      upcomingExams: upcoming.slice(0, 4).map(examDto),
      subjects: subjects.map((subject) => {
        const plan = planBySubject.get(subject._id.toString());
        const totalMarks = (plan?.components || []).reduce(
          (total, component) => total + (component.maxMarks || 0),
          0
        );

        return {
          ...subjectDto(subject),
          plan: plan
            ? {
                unitCount: plan.syllabus?.length || 0,
                componentCount: plan.components?.length || 0,
                totalMarks,
                updatedAt: plan.updatedAt ? plan.updatedAt.toISOString() : null,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
}

async function listExams(req, res, next) {
  try {
    const { subjectId, status, type, q } = req.query;
    const filter = {};

    if (subjectId) {
      if (!mongoose.isValidObjectId(String(subjectId))) throw new ApiError(400, 'Invalid subject');
      filter.subject = subjectId;
    }

    if (status) {
      if (!Exam.EXAM_STATUSES.includes(String(status))) throw new ApiError(400, 'Invalid status');
      filter.status = status;
    }

    if (type) {
      if (!Exam.EXAM_TYPES.includes(String(type))) throw new ApiError(400, 'Invalid exam type');
      filter.type = type;
    }

    const exams = await Exam.find(filter).populate('subject').sort({ date: 1 }).lean();
    let rows = exams.map(examDto);

    if (q) {
      const needle = String(q).trim().toLowerCase();
      rows = rows.filter(
        (exam) =>
          exam.name.toLowerCase().includes(needle) ||
          (exam.subject?.code || '').toLowerCase().includes(needle) ||
          (exam.subject?.name || '').toLowerCase().includes(needle)
      );
    }

    const subjects = await Subject.find({}).sort({ department: 1, semester: 1, code: 1 }).lean();

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      exams: rows,
      subjects: subjects.map(subjectDto),
      types: Exam.EXAM_TYPES,
      statuses: Exam.EXAM_STATUSES,
    });
  } catch (error) {
    return next(error);
  }
}

async function createExam(req, res, next) {
  try {
    const payload = validateExamPayload(req.body);
    const subject = await resolveSubject(payload.subjectId);

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
      exam: examDto(exam),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateExam(req, res, next) {
  try {
    const { examId } = req.params;
    if (!mongoose.isValidObjectId(examId)) throw new ApiError(400, 'Invalid exam');

    const exam = await Exam.findById(examId);
    if (!exam) throw new ApiError(404, 'Exam not found');

    const payload = validateExamPayload(req.body);
    const subject = await resolveSubject(payload.subjectId);

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
      exam: examDto(exam),
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteExam(req, res, next) {
  try {
    const { examId } = req.params;
    if (!mongoose.isValidObjectId(examId)) throw new ApiError(400, 'Invalid exam');

    const exam = await Exam.findById(examId);
    if (!exam) throw new ApiError(404, 'Exam not found');

    await exam.deleteOne();

    return res.status(200).json({ message: `${exam.name} removed.` });
  } catch (error) {
    return next(error);
  }
}

function validatePlanPayload(body) {
  const syllabus = Array.isArray(body.syllabus) ? body.syllabus : [];
  const components = Array.isArray(body.components) ? body.components : [];
  const notes = String(body.notes || '').trim();

  if (syllabus.length > MAX_UNITS) {
    throw new ApiError(400, `A syllabus can have at most ${MAX_UNITS} units`);
  }

  if (components.length > MAX_COMPONENTS) {
    throw new ApiError(400, `A marks scheme can have at most ${MAX_COMPONENTS} components`);
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
    const maxMarks = parseMarks(component.maxMarks, `Component ${index + 1} marks`);

    if (!name) throw new ApiError(400, `Component ${index + 1} needs a name`);
    if (name.length > 80) throw new ApiError(400, `Component ${index + 1} name is too long`);
    if (maxMarks < 1 || maxMarks > 1000) {
      throw new ApiError(400, `Component ${index + 1} marks must be between 1 and 1000`);
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

async function subjectPlans(req, res, next) {
  try {
    const [subjects, plans] = await Promise.all([
      Subject.find({}).sort({ department: 1, semester: 1, code: 1 }).lean(),
      SubjectPlan.find({}).lean(),
    ]);

    const planBySubject = new Map(
      plans.map((plan) => [plan.subject.toString(), plan])
    );

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      subjects: subjects.map((subject) => {
        const plan = planBySubject.get(subject._id.toString());
        const totalMarks = (plan?.components || []).reduce(
          (sum, component) => sum + (component.maxMarks || 0),
          0
        );

        return {
          ...subjectDto(subject),
          plan: plan
            ? {
                unitCount: plan.syllabus?.length || 0,
                componentCount: plan.components?.length || 0,
                totalMarks,
                updatedAt: plan.updatedAt ? plan.updatedAt.toISOString() : null,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
}

async function getPlan(req, res, next) {
  try {
    const { subjectId } = req.params;
    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findById(subjectId).lean();
    if (!subject) throw new ApiError(404, 'Subject not found');

    const plan = await SubjectPlan.findOne({ subject: subject._id }).lean();
    const updatedBy = plan?.updatedBy
      ? await User.findById(plan.updatedBy).select('name').lean()
      : null;

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      subject: subjectDto(subject),
      plan: {
        syllabus: (plan?.syllabus || []).map((unit) => ({
          title: unit.title,
          topics: unit.topics || '',
        })),
        components: (plan?.components || []).map((component) => ({
          name: component.name,
          maxMarks: component.maxMarks,
        })),
        notes: plan?.notes || '',
        totalMarks: (plan?.components || []).reduce(
          (sum, component) => sum + (component.maxMarks || 0),
          0
        ),
        updatedAt: plan?.updatedAt ? plan.updatedAt.toISOString() : null,
        updatedBy: updatedBy?.name || null,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function savePlan(req, res, next) {
  try {
    const { subjectId } = req.params;
    if (!mongoose.isValidObjectId(subjectId)) throw new ApiError(400, 'Invalid subject');

    const subject = await Subject.findById(subjectId).lean();
    if (!subject) throw new ApiError(404, 'Subject not found');

    const payload = validatePlanPayload(req.body);

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
    ).lean();

    const totalMarks = plan.components.reduce(
      (sum, component) => sum + (component.maxMarks || 0),
      0
    );

    return res.status(200).json({
      message: `Syllabus and marks saved for ${subject.code}.`,
      subject: subjectDto(subject),
      plan: {
        syllabus: plan.syllabus.map((unit) => ({ title: unit.title, topics: unit.topics || '' })),
        components: plan.components.map((component) => ({
          name: component.name,
          maxMarks: component.maxMarks,
        })),
        notes: plan.notes || '',
        totalMarks,
        updatedAt: plan.updatedAt ? plan.updatedAt.toISOString() : null,
        updatedBy: req.user.name,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  overview,
  listExams,
  examDto,
  validateExamPayload,
  resolveSubject,
  createExam,
  updateExam,
  deleteExam,
  subjectPlans,
  getPlan,
  savePlan,
};
