const path = require('path');
const AnalysisJob = require('../models/AnalysisJob');
const Attachment = require('../models/Attachment');
const Exam = require('../models/Exam');
const PastPaperAnalysis = require('../models/PastPaperAnalysis');
const PastQuestionPaper = require('../models/PastQuestionPaper');
const QuestionBank = require('../models/QuestionBank');
const { extractDocumentText } = require('./documentTextExtractor');
const { boardSyllabusFor } = require('./paperService');
const {
  generateQuestionBank,
  analyzePastPapers,
} = require('./googleAiStudioQuestionBank');

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx']);
const queue = [];
const queuedIds = new Set();
const activeIds = new Set();
let workerScheduled = false;

function activeKeyFor(facultyId, examId, type) {
  return `${facultyId}:${examId}:${type}`;
}

function scheduleWorker() {
  if (workerScheduled) return;
  workerScheduled = true;
  setImmediate(processQueue);
}

function scheduleJob(jobId) {
  const id = String(jobId);
  if (queuedIds.has(id) || activeIds.has(id)) return;
  queuedIds.add(id);
  queue.push(id);
  scheduleWorker();
}

async function enqueueAnalysisJob({
  examId,
  facultyId,
  subjectId,
  type,
  attachmentIds = [],
  paperIds = [],
}) {
  const activeKey = activeKeyFor(facultyId, examId, type);
  let job = await AnalysisJob.findOne({ activeKey }).lean();

  if (!job) {
    try {
      job = await AnalysisJob.create({
        exam: examId,
        faculty: facultyId,
        subject: subjectId,
        type,
        activeKey,
        attachmentIds,
        paperIds,
      });
      job = job.toObject();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      job = await AnalysisJob.findOne({ activeKey }).lean();
      if (!job) throw error;
    }
  }

  if (['queued', 'processing'].includes(job.status)) {
    scheduleJob(job._id);
  }
  return job;
}

async function readableSource(document, label, { required = true } = {}) {
  try {
    const extracted = await extractDocumentText(document, { required });
    if (!extracted.text.trim()) return null;
    return {
      ...extracted,
      attachmentId: document._id,
      name: document.originalName,
      label,
    };
  } catch (error) {
    if (!required) return null;
    throw new Error(`Could not read "${document.originalName}": ${error.message}`);
  }
}

async function loadNotes(job) {
  const noteIds = (job.attachmentIds || []).map(String);
  if (!noteIds.length) {
    throw new Error('No class notes were selected for this analysis');
  }

  const attachments = await Attachment.find({
    _id: { $in: job.attachmentIds },
    kind: 'document',
  })
    .populate({ path: 'session', select: 'subject topic' })
    .lean();
  const byId = new Map(
    attachments.map((attachment) => [attachment._id.toString(), attachment])
  );

  if (
    attachments.length !== noteIds.length ||
    noteIds.some((id) => {
      const attachment = byId.get(id);
      return (
        !attachment ||
        !attachment.session ||
        attachment.session.subject?.toString() !== job.subject.toString() ||
        !SUPPORTED_EXTENSIONS.has(
          path.extname(attachment.originalName).toLowerCase()
        )
      );
    })
  ) {
    throw new Error('One or more selected notes are no longer available for this subject');
  }

  return Promise.all(
    noteIds.map((id) => {
      const attachment = byId.get(id);
      return readableSource(attachment, attachment.session.topic || 'Class notes');
    })
  );
}

async function runNotesBank(job) {
  const exam = await Exam.findById(job.exam).populate('subject').lean();
  if (!exam?.subject) throw new Error('The examination for this analysis no longer exists');

  const syllabus = await boardSyllabusFor(exam.subject._id);
  if (!syllabus.length) {
    throw new Error('The Examination Board has not published a syllabus for this subject');
  }

  const notes = await loadNotes(job);
  const generated = await generateQuestionBank({
    exam: {
      name: exam.name,
      type: exam.type,
      maximumMarks: exam.maxMarks,
      subject: exam.subject.name,
      subjectCode: exam.subject.code,
    },
    syllabus,
    notes,
    pastPapers: [],
  });

  const title = `${exam.name} notes question bank`.slice(0, 160);
  const bank = await QuestionBank.create({
    exam: exam._id,
    subject: exam.subject._id,
    faculty: job.faculty,
    title,
    questions: generated.questions,
    analysis: generated.analysis,
    sources: {
      notes: notes.map((note) => ({
        attachmentId: note.attachmentId,
        name: note.name,
        sessionTopic: note.label === 'Class notes' ? '' : note.label,
      })),
      pastPapers: [],
    },
    engine: generated.engine,
  });

  return {
    resultBank: bank._id,
    message: 'Question bank generated from the uploaded class notes.',
    warnings: [],
  };
}

async function runPastPaperAnalysis(job) {
  const exam = await Exam.findById(job.exam).populate('subject').lean();
  if (!exam?.subject) throw new Error('The examination for this analysis no longer exists');

  const syllabus = await boardSyllabusFor(exam.subject._id);
  if (!syllabus.length) {
    throw new Error('The Examination Board has not published a syllabus for this subject');
  }

  const papers = await PastQuestionPaper.find({
    _id: { $in: job.paperIds },
    subject: exam.subject._id,
  })
    .sort({ year: 1 })
    .lean();
  if (papers.length !== (job.paperIds || []).length) {
    throw new Error('One or more past papers were removed before the analysis could finish');
  }
  if (!papers.length) {
    throw new Error('No past question papers were selected for this analysis');
  }

  const extracted = [];
  const skipped = [];
  for (const paper of papers) {
    const source = await readableSource(paper, String(paper.year), {
      required: false,
    });
    if (!source) {
      skipped.push(paper);
      continue;
    }
    extracted.push({ ...source, year: paper.year });
  }
  if (!extracted.length) {
    throw new Error(
      'None of the uploaded past papers contain selectable text. Scanned papers need OCR before analysis.'
    );
  }

  const analysis = await analyzePastPapers({
    exam: {
      name: exam.name,
      type: exam.type,
      maximumMarks: exam.maxMarks,
      subject: exam.subject.name,
      subjectCode: exam.subject.code,
    },
    syllabus,
    pastPapers: extracted,
  });

  const saved = await PastPaperAnalysis.findOneAndUpdate(
    { exam: exam._id, faculty: job.faculty },
    {
      $set: {
        subject: exam.subject._id,
        papers: extracted.map((paper) => ({
          year: paper.year,
          name: paper.name,
        })),
        analysis: analysis.analysis,
        engine: analysis.engine,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  const warnings = skipped.length
    ? [
        `Skipped ${skipped.length} paper(s) with no readable text (${skipped
          .map((paper) => paper.year)
          .join(', ')}).`,
      ]
    : [];

  return {
    resultAnalysis: saved._id,
    message: `Past-paper analysis saved.${warnings.length ? ` ${warnings[0]}` : ''}`,
    warnings,
  };
}

async function processJob(jobId) {
  const job = await AnalysisJob.findOneAndUpdate(
    { _id: jobId, status: 'queued' },
    { $set: { status: 'processing', error: '', startedAt: new Date() } },
    { new: true }
  ).lean();
  if (!job) return;

  try {
    const result =
      job.type === 'notes_bank'
        ? await runNotesBank(job)
        : await runPastPaperAnalysis(job);

    await AnalysisJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'completed',
          error: '',
          message: result.message,
          warnings: result.warnings,
          resultBank: result.resultBank || null,
          resultAnalysis: result.resultAnalysis || null,
          completedAt: new Date(),
        },
        $unset: { activeKey: 1 },
      }
    );
  } catch (error) {
    const message = String(error.message || 'Unknown analysis error').slice(0, 1000);
    console.error(`[question-bank] analysis ${jobId} failed: ${message}`);
    await AnalysisJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'failed',
          error: message,
          message:
            job.type === 'notes_bank'
              ? 'Question-bank generation failed.'
              : 'Past-paper analysis failed.',
          completedAt: new Date(),
        },
        $unset: { activeKey: 1 },
      }
    );
  }
}

async function processQueue() {
  workerScheduled = false;
  const jobId = queue.shift();
  if (!jobId) return;

  queuedIds.delete(jobId);
  activeIds.add(jobId);

  try {
    await processJob(jobId);
  } catch (error) {
    console.error(`[question-bank] could not process job ${jobId}:`, error);
  } finally {
    activeIds.delete(jobId);
    if (queue.length) scheduleWorker();
  }
}

async function resumePendingQuestionBankJobs() {
  await AnalysisJob.updateMany(
    { status: 'processing' },
    { $set: { status: 'queued', startedAt: null } }
  );
  const jobs = await AnalysisJob.find({ status: 'queued' })
    .select('_id')
    .lean();

  for (const job of jobs) scheduleJob(job._id);
  return jobs.length;
}

module.exports = {
  enqueueAnalysisJob,
  resumePendingQuestionBankJobs,
};
