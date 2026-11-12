const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const Exam = require('../models/Exam');
const QuestionPaper = require('../models/QuestionPaper');
const SubjectPlan = require('../models/SubjectPlan');
const { ApiError } = require('../middleware/errorHandler');
const { CRITERIA, recommendationFrom } = require('../services/paperEvaluator');
const { boardSyllabusFor, reevaluateExamPapers } = require('../services/paperService');
const { enqueuePaperEvaluation } = require('../services/paperEvaluationWorker');
const { DIFFICULTIES, COGNITIVE_LEVELS } = require('../models/QuestionPaper');
const { UPLOAD_DIR, metaFor, removeFiles } = require('../middleware/upload');

const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 40;

function subjectDto(subject) {
  if (!subject) return null;

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
    subject: subjectDto(exam.subject),
  };
}

function planDto(plan) {
  if (!plan) return null;

  return {
    unitCount: plan.syllabus?.length || 0,
    units: (plan.syllabus || []).map((unit) => ({
      title: unit.title,
      topics: unit.topics || '',
    })),
    components: (plan.components || []).map((component) => ({
      name: component.name,
      maxMarks: component.maxMarks,
    })),
    totalMarks: (plan.components || []).reduce(
      (sum, component) => sum + (component.maxMarks || 0),
      0
    ),
    updatedAt: plan.updatedAt ? plan.updatedAt.toISOString() : null,
  };
}

function evaluationDto(evaluation, submissionType) {
  if (!evaluation) return null;

  return {
    status:
      evaluation.status ||
      (submissionType === 'document' ? 'queued' : 'completed'),
    error: evaluation.error || '',
    total: evaluation.total || 0,
    breakdown: (evaluation.breakdown || []).map((criterion) => ({
      key: criterion.key,
      label: criterion.label,
      weight: criterion.weight,
      score: criterion.score,
      earned: criterion.earned,
    })),
    summary: evaluation.summary || '',
    strengths: evaluation.strengths || [],
    risks: evaluation.risks || [],
    engine: evaluation.engine || '',
    evaluatedAt: evaluation.evaluatedAt ? evaluation.evaluatedAt.toISOString() : null,
  };
}

function documentDto(document) {
  if (!document || !document.storedName) return null;

  return {
    name: document.originalName,
    extension: (document.originalName.split('.').pop() || '').toUpperCase(),
    mimeType: document.mimeType,
    size: document.size,
    uploadedAt: document.uploadedAt ? document.uploadedAt.toISOString() : null,
  };
}

function paperDto(paper) {
  const faculty = paper.faculty && paper.faculty.name ? paper.faculty : null;

  return {
    id: paper._id.toString(),
    title: paper.title,
    submissionType: paper.submissionType === 'document' ? 'document' : 'structured',
    status: paper.status,
    totalMarks: paper.totalMarks,
    paperDocument: documentDto(paper.paperDocument),
    answerKeyDocument: documentDto(paper.answerKeyDocument),
    questions: (paper.questions || []).map((question) => ({
      text: question.text,
      unit: question.unit,
      marks: question.marks,
      difficulty: question.difficulty,
      cognitive: question.cognitive,
      answerKey: question.answerKey || '',
    })),
    evaluation: evaluationDto(paper.evaluation, paper.submissionType),
    faculty: faculty
      ? { id: faculty._id.toString(), name: faculty.name }
      : { id: paper.faculty?.toString?.() || '', name: '' },
    submittedAt: paper.createdAt ? paper.createdAt.toISOString() : null,
    reviewedAt: paper.reviewedAt ? paper.reviewedAt.toISOString() : null,
    reviewNote: paper.reviewNote || '',
    approved: paper.status === 'approved',
  };
}

function startOfToday() {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now;
}

function assertExamOpen(exam) {
  if (exam.status !== 'scheduled') {
    throw new ApiError(400, 'Only scheduled examinations accept question-paper sets');
  }

  if (exam.date < startOfToday()) {
    throw new ApiError(400, 'This examination has already taken place');
  }
}

function parseQuestions(raw, syllabus) {
  const questions = Array.isArray(raw) ? raw : [];

  if (questions.length < MIN_QUESTIONS) {
    throw new ApiError(400, `A paper needs at least ${MIN_QUESTIONS} questions`);
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new ApiError(400, `A paper can have at most ${MAX_QUESTIONS} questions`);
  }

  const unitByKey = new Map(
    syllabus.map((unit) => [unit.title.trim().toLowerCase(), unit.title.trim()])
  );

  return questions.map((question, index) => {
    const label = `Question ${index + 1}`;
    const text = String(question.text || '').trim();
    if (!text) throw new ApiError(400, `${label} needs question text`);
    if (text.length > 1000) throw new ApiError(400, `${label} text is too long`);

    const unitKey = String(question.unit || '').trim().toLowerCase();
    const unit = unitByKey.get(unitKey);
    if (!unit) throw new ApiError(400, `${label} must map to a unit in the board syllabus`);

    const marks = Number(question.marks);
    if (!Number.isInteger(marks) || marks < 1 || marks > 100) {
      throw new ApiError(400, `${label} marks must be a whole number between 1 and 100`);
    }

    const difficulty = String(question.difficulty || '');
    if (!DIFFICULTIES.includes(difficulty)) {
      throw new ApiError(400, `${label} has an invalid difficulty`);
    }

    const cognitive = String(question.cognitive || '');
    if (!COGNITIVE_LEVELS.includes(cognitive)) {
      throw new ApiError(400, `${label} has an invalid cognitive level`);
    }

    const answerKey = String(question.answerKey || '').trim();
    if (answerKey.length > 2000) throw new ApiError(400, `${label} answer key is too long`);

    return { text, unit, marks, difficulty, cognitive, answerKey };
  });
}

function paperPayload(body, exam, syllabus) {
  const title = String(body.title || '').trim();
  if (!title) throw new ApiError(400, 'Give this paper set a title');
  if (title.length > 120) throw new ApiError(400, 'The paper title must be 120 characters or fewer');

  const questions = parseQuestions(body.questions, syllabus);
  const totalMarks = questions.reduce((sum, question) => sum + question.marks, 0);

  if (totalMarks !== exam.maxMarks) {
    throw new ApiError(
      400,
      `The paper totals ${totalMarks} marks but this exam is out of ${exam.maxMarks}`
    );
  }

  return { title, questions, totalMarks };
}

async function loadExam(examId) {
  if (!mongoose.isValidObjectId(examId)) throw new ApiError(400, 'Invalid examination');

  const exam = await Exam.findById(examId).populate('subject').lean();
  if (!exam) throw new ApiError(404, 'Examination not found');

  return exam;
}

async function resolveSyllabus(exam) {
  const syllabus = await boardSyllabusFor(exam.subject._id);

  if (!syllabus.length) {
    throw new ApiError(
      400,
      'The Examination Board has not published a syllabus for this subject yet'
    );
  }

  return syllabus;
}

async function listFacultyPapers(req, res, next) {
  try {
    const exams = await Exam.find({ status: { $ne: 'cancelled' } })
      .populate('subject')
      .sort({ date: 1 })
      .lean();

    const subjectIds = exams.map((exam) => exam.subject?._id).filter(Boolean);
    const plans = subjectIds.length
      ? await SubjectPlan.find({ subject: { $in: subjectIds } }).lean()
      : [];
    const planBySubject = new Map(plans.map((plan) => [plan.subject.toString(), plan]));

    const examIds = exams.map((exam) => exam._id);
    const papers = examIds.length
      ? await QuestionPaper.find({ exam: { $in: examIds } })
          .populate('faculty', 'name')
          .lean()
      : [];

    const papersByExam = new Map();
    for (const paper of papers) {
      const key = paper.exam.toString();
      const bucket = papersByExam.get(key) || [];
      bucket.push(paper);
      papersByExam.set(key, bucket);
    }

    const today = startOfToday();

    const payload = exams
      .filter((exam) => exam.subject)
      .map((exam) => {
        const allPapers = papersByExam.get(exam._id.toString()) || [];
        const mine = allPapers.filter(
          (paper) => paper.faculty?._id?.toString() === req.user._id.toString()
        );

        return {
          ...examDto(exam),
          isOpen: exam.status === 'scheduled' && exam.date >= today,
          boardPlan: planDto(planBySubject.get(exam.subject._id.toString())),
          paperCount: allPapers.length,
          myPapers: mine.map(paperDto),
          recommendedPaperId: recommendationFrom(allPapers),
        };
      })
      .sort((left, right) => {
        if (left.isOpen !== right.isOpen) return left.isOpen ? -1 : 1;
        return left.date < right.date ? -1 : 1;
      });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      exams: payload,
      criteria: CRITERIA,
      difficulties: DIFFICULTIES,
      cognitiveLevels: COGNITIVE_LEVELS,
    });
  } catch (error) {
    return next(error);
  }
}

async function createPaper(req, res, next) {
  try {
    const exam = await loadExam(req.body.examId);
    assertExamOpen(exam);

    const syllabus = await resolveSyllabus(exam);
    const payload = paperPayload(req.body, exam, syllabus);

    const existing = await QuestionPaper.findOne({
      exam: exam._id,
      faculty: req.user._id,
      title: payload.title,
    }).lean();

    if (existing) {
      throw new ApiError(409, 'You already submitted a set with that title for this exam');
    }

    const paper = await QuestionPaper.create({
      exam: exam._id,
      subject: exam.subject._id,
      faculty: req.user._id,
      title: payload.title,
      submissionType: 'structured',
      questions: payload.questions,
      totalMarks: payload.totalMarks,
      status: 'submitted',
    });

    await reevaluateExamPapers(exam._id);

    const saved = await QuestionPaper.findById(paper._id).populate('faculty', 'name').lean();

    return res.status(201).json({
      message: `${saved.title} submitted for AI evaluation.`,
      paper: paperDto(saved),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return next(new ApiError(409, 'You already submitted a set with that title for this exam'));
    }
    return next(error);
  }
}

function storedDocument(file) {
  const meta = metaFor(file.originalname);

  return {
    originalName: file.originalname,
    storedName: file.filename,
    mimeType: meta.mimeType,
    size: file.size,
    uploadedAt: new Date(),
  };
}

async function createPaperDocument(req, res, next) {
  const files = Object.values(req.files || {}).flat();

  try {
    const exam = await loadExam(req.body.examId);
    assertExamOpen(exam);
    await resolveSyllabus(exam);

    const title = String(req.body.title || '').trim();
    if (!title) throw new ApiError(400, 'Give this paper set a title');
    if (title.length > 120) {
      throw new ApiError(400, 'The paper title must be 120 characters or fewer');
    }

    const paperFile = req.files?.paperFile?.[0];
    const answerKeyFile = req.files?.answerKeyFile?.[0];

    if (!paperFile) {
      throw new ApiError(400, 'Upload the question paper as a PDF or DOCX file');
    }

    const existing = await QuestionPaper.findOne({
      exam: exam._id,
      faculty: req.user._id,
      title,
    }).lean();

    if (existing) {
      throw new ApiError(409, 'You already submitted a set with that title for this exam');
    }

    const paper = await QuestionPaper.create({
      exam: exam._id,
      subject: exam.subject._id,
      faculty: req.user._id,
      title,
      submissionType: 'document',
      questions: [],
      totalMarks: exam.maxMarks,
      paperDocument: storedDocument(paperFile),
      answerKeyDocument: answerKeyFile ? storedDocument(answerKeyFile) : null,
      status: 'submitted',
      evaluation: {
        status: 'queued',
        error: '',
        total: 0,
        breakdown: [],
        summary: 'Document uploaded and queued for Google AI Studio evaluation.',
        strengths: [],
        risks: [],
        engine: 'Google AI Studio',
        evaluatedAt: null,
      },
    });

    const saved = await QuestionPaper.findById(paper._id).populate('faculty', 'name').lean();
    enqueuePaperEvaluation(paper._id);

    return res.status(201).json({
      message: `${saved.title} uploaded and queued for Google AI Studio evaluation.`,
      paper: paperDto(saved),
    });
  } catch (error) {
    // Remove the uploaded files if the paper could not be recorded.
    removeFiles(files);

    if (error?.code === 11000) {
      return next(new ApiError(409, 'You already submitted a set with that title for this exam'));
    }
    return next(error);
  }
}

async function downloadPaperDocument(req, res, next) {
  try {
    const { paperId, kind } = req.params;

    if (!mongoose.isValidObjectId(paperId)) throw new ApiError(400, 'Invalid paper');
    if (!['paper', 'answer-key'].includes(kind)) {
      throw new ApiError(400, 'Invalid paper document');
    }

    const paper = await QuestionPaper.findById(paperId).lean();
    if (!paper) throw new ApiError(404, 'Paper not found');

    if (
      req.user.role === 'faculty' &&
      paper.faculty.toString() !== req.user._id.toString()
    ) {
      throw new ApiError(403, 'That paper set belongs to another faculty member');
    }

    const document =
      kind === 'answer-key' ? paper.answerKeyDocument : paper.paperDocument;

    if (!document || !document.storedName) {
      throw new ApiError(404, 'That document has not been uploaded');
    }

    const root = path.resolve(UPLOAD_DIR);
    const filePath = path.resolve(root, document.storedName);

    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new ApiError(400, 'Invalid file reference');
    }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      throw new ApiError(404, 'The stored document is missing');
    }

    const safeName = document.originalName.replace(/["\r\n]/g, '').trim() || 'question-paper';
    const encodedName = encodeURIComponent(safeName);

    res.setHeader('Content-Type', document.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return res.sendFile(filePath);
  } catch (error) {
    return next(error);
  }
}

async function updatePaper(req, res, next) {
  try {
    const { paperId } = req.params;
    if (!mongoose.isValidObjectId(paperId)) throw new ApiError(400, 'Invalid paper');

    const paper = await QuestionPaper.findById(paperId);
    if (!paper) throw new ApiError(404, 'Paper not found');
    if (paper.faculty.toString() !== req.user._id.toString()) {
      throw new ApiError(403, 'That paper set belongs to another faculty member');
    }
    if (paper.status === 'approved') {
      throw new ApiError(400, 'An approved paper cannot be edited');
    }
    if (paper.submissionType === 'document') {
      throw new ApiError(
        400,
        'A document-based paper set cannot be edited. Withdraw it and upload a new document.'
      );
    }

    const exam = await loadExam(paper.exam);
    assertExamOpen(exam);
    const syllabus = await resolveSyllabus(exam);
    const payload = paperPayload(req.body, exam, syllabus);

    paper.set({
      title: payload.title,
      questions: payload.questions,
      totalMarks: payload.totalMarks,
      status: 'submitted',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: '',
    });
    await paper.save();

    await reevaluateExamPapers(exam._id);

    const saved = await QuestionPaper.findById(paper._id).populate('faculty', 'name').lean();

    return res.status(200).json({
      message: `${saved.title} updated and re-evaluated.`,
      paper: paperDto(saved),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return next(new ApiError(409, 'You already submitted a set with that title for this exam'));
    }
    return next(error);
  }
}

function removeStoredDocument(document) {
  if (!document?.storedName) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, document.storedName)).catch(() => {});
}

async function deletePaper(req, res, next) {
  try {
    const { paperId } = req.params;
    if (!mongoose.isValidObjectId(paperId)) throw new ApiError(400, 'Invalid paper');

    const paper = await QuestionPaper.findById(paperId);
    if (!paper) throw new ApiError(404, 'Paper not found');
    if (paper.faculty.toString() !== req.user._id.toString()) {
      throw new ApiError(403, 'That paper set belongs to another faculty member');
    }
    if (paper.status === 'approved') {
      throw new ApiError(400, 'An approved paper cannot be withdrawn');
    }

    const examId = paper.exam;
    removeStoredDocument(paper.paperDocument);
    removeStoredDocument(paper.answerKeyDocument);
    await paper.deleteOne();
    await reevaluateExamPapers(examId);

    return res.status(200).json({ message: `${paper.title} withdrawn.` });
  } catch (error) {
    return next(error);
  }
}

async function listPapersForExamCell(req, res, next) {
  try {
    const exams = await Exam.find({ status: { $ne: 'cancelled' } })
      .populate('subject')
      .sort({ date: 1 })
      .lean();

    const subjectIds = exams.map((exam) => exam.subject?._id).filter(Boolean);
    const plans = subjectIds.length
      ? await SubjectPlan.find({ subject: { $in: subjectIds } }).lean()
      : [];
    const planBySubject = new Map(plans.map((plan) => [plan.subject.toString(), plan]));

    const examIds = exams.map((exam) => exam._id);
    const papers = examIds.length
      ? await QuestionPaper.find({ exam: { $in: examIds } })
          .populate('faculty', 'name')
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

    const payload = exams
      .filter((exam) => exam.subject)
      .map((exam) => {
        const rows = (papersByExam.get(exam._id.toString()) || [])
          .slice()
          .sort((left, right) => (right.evaluation?.total || 0) - (left.evaluation?.total || 0));

        return {
          ...examDto(exam),
          boardPlan: planDto(planBySubject.get(exam.subject._id.toString())),
          approvedPaperId: exam.approvedPaper ? exam.approvedPaper.toString() : null,
          approvedAt: exam.approvedAt ? exam.approvedAt.toISOString() : null,
          paperCount: rows.length,
          papers: rows.map(paperDto),
          recommendedPaperId: recommendationFrom(rows),
        };
      });

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      exams: payload,
      criteria: CRITERIA,
      difficulties: DIFFICULTIES,
      cognitiveLevels: COGNITIVE_LEVELS,
    });
  } catch (error) {
    return next(error);
  }
}

async function approvePaper(req, res, next) {
  try {
    const { paperId } = req.params;
    if (!mongoose.isValidObjectId(paperId)) throw new ApiError(400, 'Invalid paper');

    const paper = await QuestionPaper.findById(paperId);
    if (!paper) throw new ApiError(404, 'Paper not found');
    if (paper.status === 'rejected') {
      throw new ApiError(400, 'A rejected paper cannot be approved');
    }

    const exam = await Exam.findById(paper.exam);
    if (!exam) throw new ApiError(404, 'Examination not found');
    if (exam.status === 'cancelled') {
      throw new ApiError(400, 'A cancelled examination cannot approve a paper');
    }

    await QuestionPaper.updateMany(
      { exam: exam._id, status: 'approved', _id: { $ne: paper._id } },
      { $set: { status: 'submitted', reviewedBy: null, reviewedAt: null } }
    );

    paper.status = 'approved';
    paper.reviewedBy = req.user._id;
    paper.reviewedAt = new Date();
    paper.reviewNote = String(req.body?.note || '').trim().slice(0, 500);
    await paper.save();

    exam.approvedPaper = paper._id;
    exam.approvedAt = new Date();
    exam.approvedBy = req.user._id;
    await exam.save();

    return res.status(200).json({
      message: `${paper.title} approved as the final paper for ${exam.name}.`,
      paperId: paper._id.toString(),
      approvedAt: exam.approvedAt.toISOString(),
    });
  } catch (error) {
    return next(error);
  }
}

async function rejectPaper(req, res, next) {
  try {
    const { paperId } = req.params;
    if (!mongoose.isValidObjectId(paperId)) throw new ApiError(400, 'Invalid paper');

    const paper = await QuestionPaper.findById(paperId);
    if (!paper) throw new ApiError(404, 'Paper not found');
    if (paper.status === 'rejected') throw new ApiError(400, 'That paper is already rejected');

    paper.status = 'rejected';
    paper.reviewedBy = req.user._id;
    paper.reviewedAt = new Date();
    paper.reviewNote = String(req.body?.note || '').trim().slice(0, 500);
    await paper.save();

    const exam = await Exam.findById(paper.exam);
    if (exam && exam.approvedPaper?.toString() === paper._id.toString()) {
      exam.approvedPaper = null;
      exam.approvedAt = null;
      exam.approvedBy = null;
      await exam.save();
    }

    await reevaluateExamPapers(paper.exam);

    return res.status(200).json({ message: `${paper.title} returned to the faculty.` });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listFacultyPapers,
  createPaper,
  createPaperDocument,
  downloadPaperDocument,
  updatePaper,
  deletePaper,
  listPapersForExamCell,
  approvePaper,
  rejectPaper,
};
