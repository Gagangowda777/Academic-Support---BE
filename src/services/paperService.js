const Exam = require('../models/Exam');
const QuestionPaper = require('../models/QuestionPaper');
const SubjectPlan = require('../models/SubjectPlan');
const { evaluatePaper, recommendationFrom } = require('./paperEvaluator');

async function boardSyllabusFor(subjectId) {
  const plan = await SubjectPlan.findOne({ subject: subjectId }).lean();
  return plan?.syllabus || [];
}

/**
 * Re-scores every active paper for one exam. Similarity depends on the other
 * submitted sets, so one new submission changes the score of the whole exam.
 */
async function reevaluateExamPapers(examId) {
  const exam = await Exam.findById(examId).lean();
  if (!exam) return [];

  const syllabus = await boardSyllabusFor(exam.subject);
  const papers = await QuestionPaper.find({
    exam: exam._id,
    status: { $ne: 'rejected' },
  }).lean();

  const structuredPapers = papers.filter(
    (paper) => paper.submissionType !== 'document'
  );

  for (const paper of structuredPapers) {
    const peers = structuredPapers.filter(
      (candidate) => candidate._id.toString() !== paper._id.toString()
    );

    const evaluation = evaluatePaper({
      questions: paper.questions,
      exam,
      syllabus,
      peers,
    });

    await QuestionPaper.updateOne(
      { _id: paper._id },
      {
        $set: {
          evaluation,
          totalMarks: paper.questions.reduce(
            (sum, question) => sum + Number(question.marks || 0),
            0
          ),
        },
      }
    );
  }

  return papers;
}

async function recommendedPaperId(examId) {
  const papers = await QuestionPaper.find({
    exam: examId,
    status: { $ne: 'rejected' },
  }).lean();

  return recommendationFrom(papers);
}

module.exports = { boardSyllabusFor, reevaluateExamPapers, recommendedPaperId };
