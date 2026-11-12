const Exam = require('../models/Exam');
const QuestionPaper = require('../models/QuestionPaper');
const { extractDocumentText } = require('./documentTextExtractor');
const { evaluateWithGoogleAIStudio } = require('./googleAiStudioPaperEvaluator');
const { boardSyllabusFor } = require('./paperService');

const queue = [];
const queuedIds = new Set();
const activeIds = new Set();
let workerScheduled = false;

function enqueuePaperEvaluation(paperId) {
  const id = String(paperId);
  if (queuedIds.has(id) || activeIds.has(id)) return;

  queuedIds.add(id);
  queue.push(id);
  scheduleWorker();
}

function scheduleWorker() {
  if (workerScheduled) return;
  workerScheduled = true;
  setImmediate(processQueue);
}

function paperComparisonText(paper) {
  if (paper.submissionType === 'document') {
    return paper.paperDocument?.extractedText || '';
  }

  return (paper.questions || [])
    .map((question) => `${question.marks} marks: ${question.text}`)
    .join('\n');
}

async function evaluateDocumentPaper(paperId) {
  const paper = await QuestionPaper.findById(paperId)
    .select('+paperDocument.extractedText +answerKeyDocument.extractedText')
    .lean();

  if (!paper || paper.submissionType !== 'document' || !paper.paperDocument) return;

  await QuestionPaper.updateOne(
    { _id: paper._id },
    {
      $set: {
        'evaluation.status': 'processing',
        'evaluation.error': '',
      },
    }
  );

  const [paperExtraction, answerKeyExtraction] = await Promise.all([
    extractDocumentText(paper.paperDocument),
    paper.answerKeyDocument
      ? extractDocumentText(paper.answerKeyDocument, { required: false })
      : Promise.resolve({ text: '', truncated: false }),
  ]);
  const [exam, syllabus, peerPapers] = await Promise.all([
    Exam.findById(paper.exam).lean(),
    boardSyllabusFor(paper.subject),
    QuestionPaper.find({
      exam: paper.exam,
      _id: { $ne: paper._id },
      status: { $ne: 'rejected' },
    })
      .select('+paperDocument.extractedText')
      .lean(),
  ]);

  if (!exam) throw new Error('The examination for this paper no longer exists');
  if (!syllabus.length) {
    throw new Error('The Examination Board has not published a syllabus for this subject');
  }

  const peers = [];
  let peerTextBudget = 20000;
  for (const peer of peerPapers) {
    if (peerTextBudget <= 0) break;
    const text = paperComparisonText(peer);
    if (!text) continue;

    const excerpt = text.slice(0, Math.min(5000, peerTextBudget));
    peers.push({ title: peer.title, text: excerpt });
    peerTextBudget -= excerpt.length;
  }

  const evaluation = await evaluateWithGoogleAIStudio({
    paperText: paperExtraction.text,
    answerKeyText: answerKeyExtraction.text,
    answerKeyProvided: Boolean(paper.answerKeyDocument),
    exam,
    syllabus,
    peers,
    paperTextTruncated: paperExtraction.truncated,
    answerKeyTextTruncated: answerKeyExtraction.truncated,
  });

  await QuestionPaper.updateOne(
    { _id: paper._id },
    {
      $set: {
        'paperDocument.extractedText': paperExtraction.text,
        ...(paper.answerKeyDocument
          ? { 'answerKeyDocument.extractedText': answerKeyExtraction.text }
          : {}),
        'evaluation.status': 'completed',
        'evaluation.error': '',
        'evaluation.total': evaluation.total,
        'evaluation.breakdown': evaluation.breakdown,
        'evaluation.summary': evaluation.summary,
        'evaluation.strengths': evaluation.strengths,
        'evaluation.risks': evaluation.risks,
        'evaluation.engine': evaluation.engine,
        'evaluation.evaluatedAt': evaluation.evaluatedAt,
      },
    }
  );
}

async function processQueue() {
  workerScheduled = false;
  const paperId = queue.shift();
  if (!paperId) return;

  queuedIds.delete(paperId);
  activeIds.add(paperId);

  try {
    await evaluateDocumentPaper(paperId);
  } catch (error) {
    const message = String(error.message || 'Unknown evaluation error').slice(0, 500);
    console.error(`[paper-evaluation] failed for ${paperId}: ${message}`);
    try {
      await QuestionPaper.updateOne(
        { _id: paperId, submissionType: 'document' },
        {
          $set: {
            'evaluation.status': 'failed',
            'evaluation.error': message,
            'evaluation.evaluatedAt': null,
          },
        }
      );
    } catch (saveError) {
      console.error(
        `[paper-evaluation] could not save failure state for ${paperId}:`,
        saveError
      );
    }
  } finally {
    activeIds.delete(paperId);
    if (queue.length) scheduleWorker();
  }
}

async function resumePendingPaperEvaluations() {
  const papers = await QuestionPaper.find({
    submissionType: 'document',
    status: { $ne: 'rejected' },
    'evaluation.status': {
      $in: ['queued', 'processing', 'not_started', null],
    },
  })
    .select('_id')
    .lean();

  for (const paper of papers) enqueuePaperEvaluation(paper._id);
  return papers.length;
}

module.exports = {
  enqueuePaperEvaluation,
  resumePendingPaperEvaluations,
};
