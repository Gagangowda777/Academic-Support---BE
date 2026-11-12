const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CRITERIA,
  recommendationFrom,
} = require('../src/services/paperEvaluator');
const {
  buildPrompt,
  parseEvaluationResponse,
  evaluateWithGoogleAIStudio,
} = require('../src/services/googleAiStudioPaperEvaluator');

function responseWithScores(value) {
  return JSON.stringify({
    scores: Object.fromEntries(CRITERIA.map((criterion) => [criterion.key, value])),
    summary: 'The paper provides a balanced assessment.',
    strengths: ['Clear questions'],
    risks: [],
  });
}

function evaluationInput() {
  return {
    paperText: 'Question 1: Explain the topic.',
    answerKeyText: '',
    answerKeyProvided: false,
    exam: { name: 'Mid-semester', type: 'mid_semester', maxMarks: 50 },
    syllabus: [{ title: 'Unit 1', topics: 'Core concepts' }],
    peers: [],
    paperTextTruncated: false,
    answerKeyTextTruncated: false,
  };
}

test('parses all seven criterion scores and computes the weighted total', () => {
  const evaluation = parseEvaluationResponse(responseWithScores(80), 'test-model');

  assert.equal(evaluation.total, 80);
  assert.equal(evaluation.breakdown.length, 7);
  assert.deepEqual(
    evaluation.breakdown.map((criterion) => criterion.key),
    CRITERIA.map((criterion) => criterion.key)
  );
  assert.equal(
    evaluation.breakdown.reduce((sum, criterion) => sum + criterion.weight, 0),
    100
  );
  assert.equal(evaluation.engine, 'Google AI Studio (test-model)');
});

test('rejects malformed or incomplete model scores instead of creating a score', () => {
  assert.throws(() => parseEvaluationResponse('not JSON', 'test-model'));

  const incomplete = JSON.parse(responseWithScores(80));
  delete incomplete.scores.answerKeyValidation;
  assert.throws(
    () => parseEvaluationResponse(JSON.stringify(incomplete), 'test-model'),
    /invalid Answer-key validation score/
  );
});

test('builds a prompt with the seven weighted rubric criteria and extracted text', () => {
  const prompt = buildPrompt(evaluationInput());

  for (const criterion of CRITERIA) {
    assert.ok(prompt.includes(criterion.key));
  }
  assert.ok(prompt.includes('Question 1: Explain the topic.'));
  assert.ok(prompt.includes('"maximumMarks":50'));
});

test('sends evaluation to Google AI Studio using the configured server-side key', async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  const originalModel = process.env.PAPER_AI_MODEL;
  let requestUrl;
  let requestOptions;

  t.after(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    else process.env.GOOGLE_AI_STUDIO_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.PAPER_AI_MODEL;
    else process.env.PAPER_AI_MODEL = originalModel;
  });

  process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
  process.env.PAPER_AI_MODEL = 'test-model';
  global.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: responseWithScores(75) }] } }],
      }),
    };
  };

  const evaluation = await evaluateWithGoogleAIStudio(evaluationInput());
  const requestBody = JSON.parse(requestOptions.body);

  assert.equal(
    requestUrl,
    'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent'
  );
  assert.equal(requestOptions.headers['x-goog-api-key'], 'test-key');
  assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
  assert.equal(evaluation.total, 75.2);
  assert.equal(evaluation.engine, 'Google AI Studio (test-model)');
});

test('requires a Google AI Studio API key', async (t) => {
  const originalApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    else process.env.GOOGLE_AI_STUDIO_API_KEY = originalApiKey;
  });

  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
  await assert.rejects(
    evaluateWithGoogleAIStudio(evaluationInput()),
    /GOOGLE_AI_STUDIO_API_KEY is required/
  );
});

test('only completed document evaluations are eligible for recommendation', () => {
  const recommendation = recommendationFrom([
    {
      _id: 'queued-document',
      submissionType: 'document',
      status: 'submitted',
      evaluation: { status: 'queued', total: 99 },
    },
    {
      _id: 'completed-document',
      submissionType: 'document',
      status: 'submitted',
      evaluation: { status: 'completed', total: 75 },
    },
  ]);

  assert.equal(recommendation, 'completed-document');
});
