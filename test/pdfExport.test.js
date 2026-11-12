const assert = require('node:assert/strict');
const test = require('node:test');
const { PDFDocument } = require('pdf-lib');
const {
  buildQuestionBankPdf,
  buildPastPaperAnalysisPdf,
} = require('../src/services/pdfExport');

const questionBank = {
  title: 'Database Management Systems notes question bank',
  engine: 'Google AI Studio (test-model)',
  createdAt: new Date('2026-11-11T10:00:00Z'),
  exam: { name: 'Mid-Semester Examination' },
  subject: { code: 'CS501', name: 'Database Management Systems' },
  sources: {
    notes: [
      {
        name: 'indexing-notes.pdf',
        sessionTopic: 'Query Optimisation & Indexing',
      },
    ],
  },
  analysis: {
    summary:
      'Questions cover indexing and normalisation.\nThey require a mix of recall and application.',
    recurringTopics: [],
    patterns: ['Definitions and query-plan interpretation alternate.'],
    recommendations: ['Include one multi-step normalisation problem.'],
    coverageGaps: ['Transactions need more coverage.'],
  },
  questions: [
    {
      text: 'Explain how a B-tree index reduces disk reads for a range query.',
      unit: 'Unit 3',
      marks: 10,
      difficulty: 'medium',
      cognitive: 'understand',
      answerKey: 'Describe ordered keys, fan-out, and leaf traversal.',
    },
    {
      text: 'Normalise a relation to third normal form and justify each step.',
      unit: 'Unit 2',
      marks: 15,
      difficulty: 'hard',
      cognitive: 'apply',
      answerKey: 'Remove partial and transitive dependencies with reasons.',
    },
  ],
};

const pastPaperAnalysis = {
  engine: 'Google AI Studio (test-model)',
  updatedAt: new Date('2026-11-11T10:30:00Z'),
  exam: { name: 'Mid-Semester Examination' },
  subject: { code: 'CS501', name: 'Database Management Systems' },
  papers: [
    { year: 2024, name: '2024.pdf' },
    { year: 2025, name: '2025.pdf' },
  ],
  analysis: {
    summary: 'Indexing and normalisation recur in most papers.',
    recurringTopics: [
      {
        topic: 'Indexing',
        unit: 'Unit 3',
        frequency: 2,
        years: [2024, 2025],
      },
    ],
    patterns: ['One numerical query-plan question per paper.'],
    recommendations: ['Practise cost estimation under different indexes.'],
    coverageGaps: ['No paper examined distributed transactions.'],
  },
};

async function assertValidPdf(buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const document = await PDFDocument.load(buffer);
  assert.ok(document.getPageCount() >= 1);
}

test('builds a downloadable question-bank PDF with questions and answer guides', async () => {
  await assertValidPdf(await buildQuestionBankPdf({ bank: questionBank }));
});

test('builds a downloadable past-paper analysis PDF with trends and sources', async () => {
  await assertValidPdf(
    await buildPastPaperAnalysisPdf({ analysis: pastPaperAnalysis })
  );
});
