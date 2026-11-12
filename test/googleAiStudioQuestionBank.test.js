const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPrompt,
  buildPastPaperAnalysisPrompt,
  parseQuestionBankResponse,
  generateQuestionBank,
  analyzePastPapers,
} = require('../src/services/googleAiStudioQuestionBank');

const syllabus = [
  { title: 'Unit 1', topics: 'Core concepts' },
  { title: 'Unit 2', topics: 'Applications' },
];

function responseObject() {
  return {
    analysis: {
      summary: 'Past papers revisit core concepts.',
      recurringTopics: [
        { topic: 'Core concepts', unit: 'Unit 1', frequency: 2, years: [2023, 2024] },
      ],
      patterns: ['Short conceptual questions recur.'],
      recommendations: ['Balance questions across the units.'],
      coverageGaps: ['Unit 2 is less represented in past papers.'],
    },
    questions: Array.from({ length: 5 }, (_, index) => ({
      text: `Explain concept ${index + 1}.`,
      unit: index % 2 ? 'Unit 2' : 'Unit 1',
      marks: 5,
      difficulty: 'medium',
      cognitive: 'understand',
      answerKey: 'A concise evidence-based answer.',
    })),
  };
}

function responseText() {
  return JSON.stringify(responseObject());
}

test('builds a question-bank prompt with syllabus, notes, and historical years', () => {
  const prompt = buildPrompt({
    exam: { name: 'Mid-semester', maximumMarks: 50 },
    syllabus,
    notes: [{ name: 'Unit notes.pdf', text: 'Definitions and examples.', truncated: false }],
    pastPapers: [{ name: 'paper.pdf', year: 2024, text: 'Question 1', truncated: false }],
  });

  assert.ok(prompt.includes('"maximumMarks":50'));
  assert.ok(prompt.includes('"historicalPaperYears":[2024]'));
  assert.ok(prompt.includes('Definitions and examples.'));
  assert.ok(prompt.includes('do not copy questions verbatim'));
  const truncatedPrompt = buildPrompt({
    exam: { name: 'Mid-semester', maximumMarks: 50 },
    syllabus,
    notes: [{ name: 'Long notes.pdf', text: 'a'.repeat(12001), truncated: false }],
    pastPapers: [],
  });
  assert.ok(truncatedPrompt.includes('truncated="true"'));
});

test('validates generated question units, classifications, and supported paper trends', () => {
  const result = parseQuestionBankResponse(responseText(), {
    syllabus,
    pastPaperYears: [2023, 2024],
  });

  assert.equal(result.questions.length, 5);
  assert.equal(result.questions[0].unit, 'Unit 1');
  assert.deepEqual(result.analysis.recurringTopics[0].years, [2023, 2024]);
  assert.throws(
    () =>
      parseQuestionBankResponse(
        JSON.stringify({
          ...responseObject(),
          questions: responseObject().questions.map((question) => ({
            ...question,
            unit: 'Unknown unit',
          })),
        }),
        { syllabus, pastPaperYears: [2023, 2024] }
      ),
    /unknown syllabus unit/
  );
});

test('rejects historical analysis that cites years not provided', () => {
  const response = responseObject();
  response.analysis.recurringTopics[0].years = [2022, 2024];
  assert.throws(
    () =>
      parseQuestionBankResponse(JSON.stringify(response), {
        syllabus,
        pastPaperYears: [2023, 2024],
      }),
    /invalid recurring-topic analysis/
  );
});

test('normalizes common difficulty and cognitive-level labels', () => {
  const response = responseObject();
  response.questions = response.questions.map((question, index) => ({
    ...question,
    difficulty: index === 0 ? 'Moderate' : 'Challenging',
    cognitive: index === 0 ? 'Application' : 'Analysing',
  }));

  const result = parseQuestionBankResponse(JSON.stringify(response), {
    syllabus,
    pastPaperYears: [2023, 2024],
  });

  assert.equal(result.questions[0].difficulty, 'medium');
  assert.equal(result.questions[0].cognitive, 'apply');
  assert.equal(result.questions[1].difficulty, 'hard');
  assert.equal(result.questions[1].cognitive, 'analyze');
});

test('repairs a cognitive label returned in the difficulty field', () => {
  const response = responseObject();
  response.questions[0] = {
    ...response.questions[0],
    difficulty: 'analyze',
    cognitive: '',
  };

  const result = parseQuestionBankResponse(JSON.stringify(response), {
    syllabus,
    pastPaperYears: [2023, 2024],
  });

  assert.equal(result.questions[0].difficulty, 'medium');
  assert.equal(result.questions[0].cognitive, 'analyze');
});

test('uses the existing Google AI Studio key and configured model', async (t) => {
  const originalApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  const originalModel = process.env.PAPER_AI_MODEL;
  let captured;

  t.after(() => {
    if (originalApiKey === undefined) delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    else process.env.GOOGLE_AI_STUDIO_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.PAPER_AI_MODEL;
    else process.env.PAPER_AI_MODEL = originalModel;
  });

  process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
  process.env.PAPER_AI_MODEL = 'test-model';

  const result = await generateQuestionBank({
    exam: { name: 'Mid-semester', maximumMarks: 50 },
    syllabus,
    notes: [],
    pastPapers: [
      { name: '2023.pdf', year: 2023, text: 'Old paper', truncated: false },
      { name: '2024.pdf', year: 2024, text: 'Recent paper', truncated: false },
    ],
  }, {
    request: async (request) => {
      captured = request;
      return {
        candidates: [{ content: { parts: [{ text: responseText() }] } }],
      };
    },
  });

  assert.equal(captured.model, 'test-model');
  assert.equal(captured.apiKey, 'test-key');
  assert.equal(
    captured.body.generationConfig.responseMimeType,
    'application/json'
  );
  assert.equal(result.engine, 'Google AI Studio (test-model)');
});

test('falls back to the configured secondary model on transient failure', async (t) => {
  const originalApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  const originalModel = process.env.PAPER_AI_MODEL;
  const originalFallback = process.env.PAPER_AI_FALLBACK_MODEL;
  const calls = [];

  t.after(() => {
    if (originalApiKey === undefined) delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    else process.env.GOOGLE_AI_STUDIO_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.PAPER_AI_MODEL;
    else process.env.PAPER_AI_MODEL = originalModel;
    if (originalFallback === undefined) delete process.env.PAPER_AI_FALLBACK_MODEL;
    else process.env.PAPER_AI_FALLBACK_MODEL = originalFallback;
  });

  process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
  process.env.PAPER_AI_MODEL = 'primary-model';
  process.env.PAPER_AI_FALLBACK_MODEL = 'fallback-model';

  const result = await generateQuestionBank(
    {
      exam: { name: 'Mid-semester', maximumMarks: 50 },
      syllabus,
      notes: [{ name: 'notes.pdf', text: 'Core concepts', truncated: false }],
      pastPapers: [
        { name: '2023.pdf', year: 2023, text: 'Core concepts', truncated: false },
        { name: '2024.pdf', year: 2024, text: 'Applications', truncated: false },
      ],
    },
    {
      request: async ({ model }) => {
        calls.push(model);
        if (model === 'primary-model') {
          const error = new Error('Google AI Studio request failed (HTTP 503)');
          error.statusCode = 503;
          throw error;
        }
        return { candidates: [{ content: { parts: [{ text: responseText() }] } }] };
      },
    }
  );

  assert.deepEqual(calls, ['primary-model', 'fallback-model']);
  assert.equal(result.engine, 'Google AI Studio (fallback-model)');
});

test('ignores paper trends in a notes-only question bank', () => {
  const result = parseQuestionBankResponse(responseText(), {
    syllabus,
    pastPaperYears: [],
  });
  assert.deepEqual(result.analysis.recurringTopics, []);
  assert.equal(result.questions.length, 5);
});

test('builds and parses a separate past-paper analysis without questions', async (t) => {
  const originalApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  const originalModel = process.env.PAPER_AI_MODEL;
  let captured;

  t.after(() => {
    if (originalApiKey === undefined) delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    else process.env.GOOGLE_AI_STUDIO_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.PAPER_AI_MODEL;
    else process.env.PAPER_AI_MODEL = originalModel;
  });

  process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
  process.env.PAPER_AI_MODEL = 'test-model';
  const pastPapers = [
    { name: '2023.pdf', year: 2023, text: 'Core concepts paper', truncated: false },
    { name: '2024.pdf', year: 2024, text: 'Applications paper', truncated: false },
  ];
  const prompt = buildPastPaperAnalysisPrompt({
    exam: { name: 'Mid-semester' },
    syllabus,
    pastPapers,
  });
  assert.ok(prompt.includes('Do not generate practice questions'));
  assert.ok(prompt.includes('"paperYears":[2023,2024]'));

  const result = await analyzePastPapers(
    { exam: { name: 'Mid-semester' }, syllabus, pastPapers },
    {
      request: async (request) => {
        captured = request;
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      analysis: responseObject().analysis,
                    }),
                  },
                ],
              },
            },
          ],
        };
      },
    }
  );

  assert.equal(captured.model, 'test-model');
  assert.equal(result.questions, undefined);
  assert.equal(result.analysis.recurringTopics.length, 1);
  assert.equal(result.engine, 'Google AI Studio (test-model)');
});
