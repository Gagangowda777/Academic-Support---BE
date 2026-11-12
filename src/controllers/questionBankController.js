const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const AnalysisJob = require('../models/AnalysisJob');
const Attachment = require('../models/Attachment');
const Exam = require('../models/Exam');
const PastPaperAnalysis = require('../models/PastPaperAnalysis');
const PastQuestionPaper = require('../models/PastQuestionPaper');
const QuestionBank = require('../models/QuestionBank');
const Session = require('../models/Session');
const { ApiError } = require('../middleware/errorHandler');
const {
  UPLOAD_DIR,
  metaFor,
  removeFiles,
} = require('../middleware/upload');
const { extractDocumentText } = require('../services/documentTextExtractor');
const { boardSyllabusFor } = require('../services/paperService');
const {
  buildQuestionBankPdf,
  buildPastPaperAnalysisPdf,
} = require('../services/pdfExport');
const { enqueueAnalysisJob } = require('../services/questionBankWorker');

const MAX_NOTES = 8;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx']);

async function ownedExam(examId, facultyId) {
  if (!mongoose.isValidObjectId(examId)) throw new ApiError(400, 'Invalid examination');

  const exam = await Exam.findById(examId).populate('subject').lean();
  if (!exam) throw new ApiError(404, 'Examination not found');
  if (
    !exam.subject ||
    exam.subject.faculty?.toString() !== facultyId.toString()
  ) {
    throw new ApiError(403, 'That examination is not assigned to you');
  }
  if (exam.status === 'cancelled') {
    throw new ApiError(400, 'A cancelled examination cannot be analysed');
  }

  return exam;
}

function documentDto(document) {
  return {
    id: document._id.toString(),
    name: document.originalName,
    size: document.size,
    mimeType: document.mimeType,
  };
}

function questionBankDto(bank) {
  return {
    id: bank._id.toString(),
    title: bank.title,
    questions: bank.questions.map((question) => ({
      text: question.text,
      unit: question.unit,
      marks: question.marks,
      difficulty: question.difficulty,
      cognitive: question.cognitive,
      answerKey: question.answerKey,
    })),
    analysis: {
      summary: bank.analysis.summary,
      recurringTopics: bank.analysis.recurringTopics.map((topic) => ({
        topic: topic.topic,
        unit: topic.unit,
        frequency: topic.frequency,
        years: topic.years,
      })),
      patterns: bank.analysis.patterns,
      recommendations: bank.analysis.recommendations,
      coverageGaps: bank.analysis.coverageGaps,
    },
    sources: bank.sources,
    engine: bank.engine,
    createdAt: bank.createdAt.toISOString(),
  };
}

function pastPaperAnalysisDto(analysis) {
  return {
    id: analysis._id.toString(),
    papers: analysis.papers,
    analysis: analysis.analysis,
    engine: analysis.engine,
    createdAt: analysis.createdAt.toISOString(),
    updatedAt: analysis.updatedAt.toISOString(),
  };
}

function analysisJobDto(job) {
  if (!job) return null;

  return {
    id: job._id.toString(),
    type: job.type,
    status: job.status,
    error: job.error || '',
    message: job.message || '',
    warnings: job.warnings || [],
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
  };
}

function sendPdf(res, buffer, title) {
  const requested = String(title || 'analysis')
    .replace(/[\\/:*?"<>|\r\n]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const filename = `${requested || 'analysis'}.pdf`;
  const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(buffer);
}

async function downloadQuestionBankPdf(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.bankId)) {
      throw new ApiError(400, 'Invalid question bank');
    }

    const bank = await QuestionBank.findById(req.params.bankId)
      .populate('exam', 'name type date')
      .populate('subject', 'code name')
      .lean();
    if (!bank) throw new ApiError(404, 'Question bank not found');
    if (bank.faculty.toString() !== req.user._id.toString()) {
      throw new ApiError(403, 'That question bank belongs to another faculty member');
    }

    const buffer = await buildQuestionBankPdf({ bank });
    return sendPdf(res, buffer, bank.title || 'question-bank');
  } catch (error) {
    return next(error);
  }
}

async function downloadPastPaperAnalysisPdf(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.analysisId)) {
      throw new ApiError(400, 'Invalid past-paper analysis');
    }

    const analysis = await PastPaperAnalysis.findById(req.params.analysisId)
      .populate('exam', 'name type date')
      .populate('subject', 'code name')
      .lean();
    if (!analysis) throw new ApiError(404, 'Past-paper analysis not found');
    if (analysis.faculty.toString() !== req.user._id.toString()) {
      throw new ApiError(403, 'That past-paper analysis belongs to another faculty member');
    }

    const buffer = await buildPastPaperAnalysisPdf({ analysis });
    return sendPdf(res, buffer, 'five-year-past-paper-analysis');
  } catch (error) {
    return next(error);
  }
}

async function questionBankContext(req, res, next) {
  try {
    const exam = await ownedExam(req.params.examId, req.user._id);
    const sessions = await Session.find({ subject: exam.subject._id })
      .select('_id topic date')
      .lean();
    const sessionById = new Map(
      sessions.map((session) => [session._id.toString(), session])
    );
    const sessionIds = sessions.map((session) => session._id);
    const documents = sessionIds.length
      ? await Attachment.find({ session: { $in: sessionIds }, kind: 'document' })
          .sort({ createdAt: -1 })
          .lean()
      : [];
    const notes = documents
      .filter((document) =>
        SUPPORTED_EXTENSIONS.has(path.extname(document.originalName).toLowerCase())
      )
      .slice(0, 50)
      .map((document) => {
        const session = sessionById.get(document.session.toString());
        return {
          ...documentDto(document),
          sessionTopic: session?.topic || '',
          sessionDate: session?.date?.toISOString() || null,
        };
      });

    const [pastPapers, banks, pastPaperAnalysis, jobs] = await Promise.all([
      PastQuestionPaper.find({ subject: exam.subject._id })
        .sort({ year: -1 })
        .lean(),
      QuestionBank.find({ exam: exam._id, faculty: req.user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      PastPaperAnalysis.findOne({ exam: exam._id, faculty: req.user._id }).lean(),
      AnalysisJob.find({ exam: exam._id, faculty: req.user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    const latestJobs = { notesBank: null, pastPapers: null };
    for (const job of jobs) {
      if (job.type === 'notes_bank' && !latestJobs.notesBank) {
        latestJobs.notesBank = analysisJobDto(job);
      }
      if (job.type === 'past_papers' && !latestJobs.pastPapers) {
        latestJobs.pastPapers = analysisJobDto(job);
      }
    }

    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      notes,
      pastPapers: pastPapers.map((paper) => ({
        ...documentDto(paper),
        year: paper.year,
        uploadedAt: paper.createdAt.toISOString(),
      })),
      yearRange: {
        first: new Date().getFullYear() - 4,
        last: new Date().getFullYear(),
      },
      banks: banks.map(questionBankDto),
      pastPaperAnalysis: pastPaperAnalysis ? pastPaperAnalysisDto(pastPaperAnalysis) : null,
      jobs: latestJobs,
    });
  } catch (error) {
    return next(error);
  }
}

function yearsFromRequest(raw, count) {
  let years;
  try {
    years = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'Provide one valid year for each past-paper file');
  }

  if (!Array.isArray(years) || years.length !== count) {
    throw new ApiError(400, 'Provide one valid year for each past-paper file');
  }

  const currentYear = new Date().getFullYear();
  const earliestYear = currentYear - 4;
  const parsed = years.map(Number);
  if (
    parsed.some(
      (year) => !Number.isInteger(year) || year < earliestYear || year > currentYear
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new ApiError(
      400,
      `Past papers must have unique years between ${earliestYear} and ${currentYear}`
    );
  }

  return parsed;
}

async function uploadPastPapers(req, res, next) {
  const files = req.files || [];

  try {
    const exam = await ownedExam(req.body.examId, req.user._id);
    if (!files.length) throw new ApiError(400, 'Choose at least one past question paper');

    const years = yearsFromRequest(req.body.years, files.length);
    const duplicates = await PastQuestionPaper.find({
      subject: exam.subject._id,
      year: { $in: years },
    })
      .select('year')
      .lean();
    if (duplicates.length) {
      throw new ApiError(
        409,
        `A past question paper is already uploaded for ${duplicates.map((paper) => paper.year).join(', ')}`
      );
    }

    const papers = files.map((file, index) => {
      const meta = metaFor(file.originalname);
      return {
        subject: exam.subject._id,
        year: years[index],
        originalName: file.originalname,
        storedName: file.filename,
        mimeType: meta.mimeType,
        size: file.size,
        uploadedBy: req.user._id,
      };
    });

    await PastQuestionPaper.insertMany(papers);
    return res.status(201).json({
      message: `${papers.length} past question paper${papers.length === 1 ? '' : 's'} uploaded.`,
    });
  } catch (error) {
    if (files.length) {
      try {
        await PastQuestionPaper.deleteMany({
          storedName: { $in: files.map((file) => file.filename) },
        });
      } catch (cleanupError) {
        console.error('[question-bank] unable to clean up uploaded past papers', cleanupError);
      }
      removeFiles(files);
    }
    return next(error);
  }
}

async function downloadPastPaper(req, res, next) {
  try {
    const { paper, filePath } = await loadOwnedPastPaper(req);
    return sendPastPaper(res, paper, filePath, 'attachment');
  } catch (error) {
    return next(error);
  }
}

async function loadOwnedPastPaper(req) {
  if (!mongoose.isValidObjectId(req.params.paperId)) {
    throw new ApiError(400, 'Invalid past question paper');
  }

  const paper = await PastQuestionPaper.findById(req.params.paperId).populate('subject').lean();
  if (!paper) throw new ApiError(404, 'Past question paper not found');
  if (paper.subject?.faculty?.toString() !== req.user._id.toString()) {
    throw new ApiError(403, 'That past question paper is not available to you');
  }

  const root = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(root, paper.storedName);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, 'Invalid file reference');
  }
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    throw new ApiError(404, 'The stored document is missing');
  }

  return { paper, filePath };
}

function sendPastPaper(res, paper, filePath, disposition) {
  const safeName = paper.originalName.replace(/["\r\n]/g, '').trim() || 'past-question-paper';
  const encodedName = encodeURIComponent(safeName);
  res.setHeader('Content-Type', paper.mimeType);
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${safeName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodedName}`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(filePath);
}

async function previewPastPaper(req, res, next) {
  try {
    const { paper, filePath } = await loadOwnedPastPaper(req);
    if (paper.mimeType !== 'application/pdf') {
      throw new ApiError(415, 'DOCX papers can be previewed as extracted text instead');
    }
    return sendPastPaper(res, paper, filePath, 'inline');
  } catch (error) {
    return next(error);
  }
}

async function previewPastPaperText(req, res, next) {
  try {
    const { paper } = await loadOwnedPastPaper(req);
    const extracted = await extractDocumentText(paper);
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({
      id: paper._id.toString(),
      name: paper.originalName,
      year: paper.year,
      text: extracted.text,
      truncated: extracted.truncated,
    });
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    return next(new ApiError(422, `Could not preview this paper: ${error.message}`));
  }
}

async function deletePastPaper(req, res, next) {
  try {
    const { paper, filePath } = await loadOwnedPastPaper(req);
    await PastPaperAnalysis.deleteMany({ subject: paper.subject._id });
    await PastQuestionPaper.deleteOne({ _id: paper._id });
    fs.promises.unlink(filePath).catch((error) => {
      console.error('[question-bank] unable to remove past-paper file', error.message);
    });
    return res.status(200).json({
      message: `${paper.year} ${paper.originalName} deleted.`,
    });
  } catch (error) {
    return next(error);
  }
}

function parseNoteIds(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_NOTES) {
    throw new ApiError(400, `Select between 1 and ${MAX_NOTES} notes to generate a question bank`);
  }
  if (
    raw.some((id) => !mongoose.isValidObjectId(id)) ||
    new Set(raw.map(String)).size !== raw.length
  ) {
    throw new ApiError(400, 'Choose valid, non-duplicate note files');
  }
  return raw;
}

async function generateQuestionBankForExam(req, res, next) {
  try {
    const exam = await ownedExam(req.body.examId, req.user._id);
    const noteIds = parseNoteIds(req.body.attachmentIds);
    const syllabus = await boardSyllabusFor(exam.subject._id);
    if (!syllabus.length) {
      throw new ApiError(400, 'The Examination Board has not published a syllabus for this subject yet');
    }

    const attachments = await Attachment.find({
      _id: { $in: noteIds },
      kind: 'document',
    })
      .populate({ path: 'session', select: 'subject topic' })
      .lean();
    const attachmentById = new Map(
      attachments.map((attachment) => [attachment._id.toString(), attachment])
    );
    if (
      attachments.length !== noteIds.length ||
      attachments.some(
        (attachment) =>
          !attachment.session ||
          attachment.session.subject?.toString() !== exam.subject._id.toString() ||
          !SUPPORTED_EXTENSIONS.has(path.extname(attachment.originalName).toLowerCase())
      )
    ) {
      throw new ApiError(400, 'One or more selected notes are not available for this subject');
    }

    const job = await enqueueAnalysisJob({
      examId: exam._id,
      facultyId: req.user._id,
      subjectId: exam.subject._id,
      type: 'notes_bank',
      attachmentIds: noteIds,
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(202).json({
      message:
        'Notes analysis started. It will continue in the background if you change section or sign out.',
      job: analysisJobDto(job),
    });
  } catch (error) {
    return next(error);
  }
}

async function analyzePastPapersForExam(req, res, next) {
  try {
    const exam = await ownedExam(req.body.examId, req.user._id);
    const syllabus = await boardSyllabusFor(exam.subject._id);
    if (!syllabus.length) {
      throw new ApiError(400, 'The Examination Board has not published a syllabus for this subject yet');
    }

    const papers = await PastQuestionPaper.find({ subject: exam.subject._id })
      .sort({ year: 1 })
      .limit(5)
      .lean();
    if (!papers.length) {
      throw new ApiError(400, 'Upload at least one past question paper before running the analysis');
    }

    const job = await enqueueAnalysisJob({
      examId: exam._id,
      facultyId: req.user._id,
      subjectId: exam.subject._id,
      type: 'past_papers',
      paperIds: papers.map((paper) => paper._id),
    });

    res.set('Cache-Control', 'private, no-store');
    return res.status(202).json({
      message:
        'Past-paper analysis started. It will continue in the background if you change section or sign out.',
      job: analysisJobDto(job),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  questionBankContext,
  uploadPastPapers,
  downloadPastPaper,
  previewPastPaper,
  previewPastPaperText,
  deletePastPaper,
  downloadQuestionBankPdf,
  downloadPastPaperAnalysisPdf,
  generateQuestionBankForExam,
  analyzePastPapersForExam,
};
