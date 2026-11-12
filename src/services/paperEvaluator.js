/**
 * Question-paper evaluation engine.
 *
 * Scores a submitted paper against the Examination Board syllabus and the
 * exam's own requirements on seven weighted criteria. The model is local and
 * deterministic, so every score can be explained from the paper itself.
 */

const CRITERIA = [
  { key: 'syllabusCoverage', label: 'Syllabus coverage', weight: 25 },
  { key: 'difficultyDistribution', label: 'Difficulty distribution', weight: 20 },
  { key: 'marksDistribution', label: 'Marks distribution', weight: 15 },
  { key: 'questionQuality', label: 'Question quality', weight: 15 },
  { key: 'cognitiveDistribution', label: 'Cognitive level distribution', weight: 10 },
  { key: 'repetitionSimilarity', label: 'Repetition & similarity', weight: 10 },
  { key: 'answerKeyValidation', label: 'Answer-key validation', weight: 5 },
];

const ENGINE = 'Campus AI Paper Check v1';

const DIFFICULTY_TARGETS = {
  internal: { easy: 0.5, medium: 0.4, hard: 0.1 },
  mid_semester: { easy: 0.4, medium: 0.4, hard: 0.2 },
  end_semester: { easy: 0.3, medium: 0.45, hard: 0.25 },
  practical: { easy: 0.3, medium: 0.5, hard: 0.2 },
  quiz: { easy: 0.6, medium: 0.3, hard: 0.1 },
  other: { easy: 0.4, medium: 0.4, hard: 0.2 },
};

const COGNITIVE_TARGETS = {
  internal: { remember: 0.3, understand: 0.3, apply: 0.25, analyze: 0.1, evaluate: 0.05, create: 0 },
  mid_semester: {
    remember: 0.2,
    understand: 0.3,
    apply: 0.3,
    analyze: 0.12,
    evaluate: 0.05,
    create: 0.03,
  },
  end_semester: {
    remember: 0.15,
    understand: 0.25,
    apply: 0.3,
    analyze: 0.15,
    evaluate: 0.08,
    create: 0.07,
  },
  practical: { remember: 0.1, understand: 0.2, apply: 0.4, analyze: 0.15, evaluate: 0.1, create: 0.05 },
  quiz: { remember: 0.45, understand: 0.35, apply: 0.2, analyze: 0, evaluate: 0, create: 0 },
  other: {
    remember: 0.2,
    understand: 0.3,
    apply: 0.3,
    analyze: 0.1,
    evaluate: 0.05,
    create: 0.05,
  },
};

const ACTION_VERBS = [
  'analyse',
  'analyze',
  'apply',
  'calculate',
  'choose',
  'classify',
  'compare',
  'compute',
  'construct',
  'contrast',
  'critique',
  'define',
  'demonstrate',
  'derive',
  'describe',
  'design',
  'determine',
  'develop',
  'differentiate',
  'discuss',
  'draw',
  'evaluate',
  'examine',
  'explain',
  'identify',
  'illustrate',
  'implement',
  'justify',
  'list',
  'outline',
  'propose',
  'prove',
  'recommend',
  'show',
  'solve',
  'state',
  'suggest',
  'summarise',
  'summarize',
  'trace',
  'write',
];

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'their',
  'using',
  'when',
  'what',
  'which',
  'where',
  'why',
  'how',
  'are',
  'was',
  'were',
  'will',
  'would',
  'should',
  'can',
  'could',
  'you',
  'its',
  'have',
  'has',
  'not',
  'but',
  'all',
  'any',
  'each',
  'between',
  'over',
  'under',
  'also',
  'explain',
  'describe',
  'discuss',
  'state',
  'define',
  'list',
  'write',
  'draw',
  'compare',
  'contrast',
]);

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tokenSet(text) {
  const words =
    String(text || '')
      .toLowerCase()
      .match(/[a-z][a-z0-9+#.-]{2,}/g) || [];

  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }

  return intersection / (left.size + right.size - intersection);
}

function normalize(text) {
  return String(text || '').trim().toLowerCase();
}

function distributionScore(counts, targets) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!total) return 0;

  let distance = 0;
  for (const key of Object.keys(targets)) {
    distance += Math.abs((counts[key] || 0) / total - targets[key]);
  }

  return clamp(100 * (1 - distance / 2));
}

function countBy(questions, field, values) {
  const counts = Object.fromEntries(values.map((value) => [value, 0]));
  for (const question of questions) {
    if (counts[question[field]] !== undefined) counts[question[field]] += 1;
  }
  return counts;
}

function syllabusCoverage(questions, syllabus) {
  if (!syllabus.length) return { score: 0, covered: 0, total: 0, topicRatio: 0 };

  const units = syllabus.map((unit) => ({
    title: normalize(unit.title),
    tokens: tokenSet(`${unit.title} ${unit.topics || ''}`),
  }));

  const covered = new Set();
  for (const question of questions) {
    const unitKey = normalize(question.unit);

    const byTitle = units.findIndex((unit) => unit.title === unitKey);
    if (byTitle >= 0) {
      covered.add(byTitle);
      continue;
    }

    const questionTokens = tokenSet(question.text);
    units.forEach((unit, index) => {
      if (jaccard(questionTokens, unit.tokens) >= 0.15) covered.add(index);
    });
  }

  const topicTokens = new Set();
  for (const unit of units) {
    for (const token of unit.tokens) topicTokens.add(token);
  }

  const questionTokens = new Set();
  for (const question of questions) {
    for (const token of tokenSet(question.text)) questionTokens.add(token);
  }

  let matchedTopics = 0;
  for (const token of topicTokens) {
    if (questionTokens.has(token)) matchedTopics += 1;
  }

  const topicRatio = topicTokens.size ? matchedTopics / topicTokens.size : 0;
  const unitRatio = covered.size / (units.length || 1);

  return {
    score: clamp(unitRatio * 70 + topicRatio * 30),
    covered: covered.size,
    total: units.length,
    topicRatio,
  };
}

function marksDistribution(questions, exam) {
  const total = questions.reduce((sum, question) => sum + Number(question.marks || 0), 0);
  const maxMarks = Number(exam.maxMarks) || 0;

  // The total was validated on submission; a mismatch is still heavily penalised.
  const totalScore = maxMarks > 0 ? clamp(60 * (1 - Math.abs(total - maxMarks) / maxMarks)) : 0;

  const marks = questions.map((question) => Number(question.marks || 0)).filter(Boolean);
  const largest = marks.length ? Math.max(...marks) / (total || 1) : 1;
  const spreadScore = largest <= 0.25 ? 20 : largest <= 0.4 ? 14 : 8;

  const count = questions.length;
  const countScore = count >= 8 ? 20 : count >= 5 ? 16 : count >= 3 ? 10 : 4;

  return clamp(totalScore + spreadScore + countScore);
}

function questionQuality(questions) {
  if (!questions.length) return 0;

  let sum = 0;

  for (const question of questions) {
    const text = String(question.text || '').trim();
    const words = text.split(/\s+/).filter(Boolean);
    let score = 0;

    if (words.length >= 10) score += 0.4;
    else if (words.length >= 6) score += 0.25;
    else if (words.length >= 3) score += 0.1;

    if (text.length >= 40) score += 0.15;
    if (ACTION_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(text))) score += 0.25;
    if (text.includes('?')) score += 0.05;
    if (Number(question.marks) >= 2) score += 0.1;
    if (question.unit) score += 0.05;

    sum += Math.min(score, 1);
  }

  return clamp((sum / questions.length) * 100);
}

function repetitionSimilarity(questions, peers) {
  const ownTokens = questions.map((question) => tokenSet(question.text));
  let duplicatePairs = 0;

  for (let i = 0; i < ownTokens.length; i += 1) {
    for (let j = i + 1; j < ownTokens.length; j += 1) {
      if (jaccard(ownTokens[i], ownTokens[j]) >= 0.75) duplicatePairs += 1;
    }
  }

  const peerTokens = [];
  for (const peer of peers) {
    for (const question of peer.questions || []) {
      peerTokens.push(tokenSet(question.text));
    }
  }

  let similaritySum = 0;
  for (const tokens of ownTokens) {
    let best = 0;
    for (const other of peerTokens) {
      const similarity = jaccard(tokens, other);
      if (similarity > best) best = similarity;
    }
    similaritySum += best;
  }

  const averageSimilarity = ownTokens.length ? similaritySum / ownTokens.length : 0;
  const duplicatePenalty = ownTokens.length ? (duplicatePairs / ownTokens.length) * 100 : 0;

  return {
    score: clamp(100 - duplicatePenalty - averageSimilarity * 65),
    duplicatePairs,
    averageSimilarity,
  };
}

function answerKeyValidation(questions) {
  if (!questions.length) return { score: 0, complete: 0, total: 0 };

  let points = 0;
  let complete = 0;

  for (const question of questions) {
    const key = String(question.answerKey || '').trim();
    const words = key.split(/\s+/).filter(Boolean);

    if (key && words.length >= 3 && key.length >= 12) {
      points += 1;
      complete += 1;
    } else if (key) {
      points += 0.5;
    }
  }

  return { score: clamp((points / questions.length) * 100), complete, total: questions.length };
}

function evaluatePaper({ questions = [], exam, syllabus = [], peers = [] }) {
  const coverage = syllabusCoverage(questions, syllabus);
  const difficultyCounts = countBy(questions, 'difficulty', ['easy', 'medium', 'hard']);
  const cognitiveCounts = countBy(questions, 'cognitive', [
    'remember',
    'understand',
    'apply',
    'analyze',
    'evaluate',
    'create',
  ]);

  const difficultyTargets = DIFFICULTY_TARGETS[exam.type] || DIFFICULTY_TARGETS.other;
  const cognitiveTargets = COGNITIVE_TARGETS[exam.type] || COGNITIVE_TARGETS.other;

  const marks = marksDistribution(questions, exam);
  const quality = questionQuality(questions);
  const similarity = repetitionSimilarity(questions, peers);
  const keys = answerKeyValidation(questions);

  const scores = {
    syllabusCoverage: coverage.score,
    difficultyDistribution: distributionScore(difficultyCounts, difficultyTargets),
    marksDistribution: marks,
    questionQuality: quality,
    cognitiveDistribution: distributionScore(cognitiveCounts, cognitiveTargets),
    repetitionSimilarity: similarity.score,
    answerKeyValidation: keys.score,
  };

  const breakdown = CRITERIA.map((criterion) => ({
    key: criterion.key,
    label: criterion.label,
    weight: criterion.weight,
    score: round(scores[criterion.key]),
    earned: round((scores[criterion.key] * criterion.weight) / 100),
  }));

  const total = round(
    breakdown.reduce((sum, criterion) => sum + criterion.earned, 0)
  );

  const strengths = [];
  const risks = [];

  if (coverage.total && coverage.covered === coverage.total) {
    strengths.push(`Covers all ${coverage.total} units in the board syllabus.`);
  } else if (coverage.total) {
    risks.push(`Covers ${coverage.covered} of ${coverage.total} board syllabus units.`);
  } else {
    risks.push('No Examination Board syllabus is published for this subject.');
  }

  if (scores.difficultyDistribution >= 80) {
    strengths.push('Difficulty mix closely matches the expected paper profile.');
  } else if (scores.difficultyDistribution < 55) {
    risks.push('Difficulty mix is skewed away from the expected profile.');
  }

  if (keys.complete === keys.total && keys.total) {
    strengths.push(`Answer keys are complete for all ${keys.total} questions.`);
  } else if (keys.total) {
    risks.push(`Only ${keys.complete} of ${keys.total} questions have a complete answer key.`);
  }

  if (similarity.duplicatePairs > 0) {
    risks.push(`${similarity.duplicatePairs} question pair(s) repeat the same content.`);
  }
  if (similarity.averageSimilarity >= 0.5) {
    risks.push('Several questions closely resemble another submitted set.');
  }

  if (scores.questionQuality < 55) {
    risks.push('Some questions are terse; add context and an action verb.');
  }

  if (marks < 80) {
    risks.push('Marks allocation or spread needs review against the exam blueprint.');
  }

  const summary = `${coverage.covered}/${coverage.total} board units covered · ${questions.length} questions · ${questions.reduce(
    (sum, question) => sum + Number(question.marks || 0),
    0
  )}/${exam.maxMarks} marks · ${keys.complete}/${keys.total} answer keys complete.`;

  return {
    status: 'completed',
    error: '',
    total,
    breakdown,
    summary,
    strengths: strengths.slice(0, 3),
    risks: risks.slice(0, 3),
    engine: ENGINE,
    evaluatedAt: new Date(),
    metrics: {
      unitsCovered: coverage.covered,
      unitsTotal: coverage.total,
      difficulty: difficultyCounts,
      cognitive: cognitiveCounts,
      duplicatePairs: similarity.duplicatePairs,
      averageSimilarity: round(similarity.averageSimilarity, 3),
      answerKeysComplete: keys.complete,
    },
  };
}

function recommendationFrom(papers) {
  const eligible = papers.filter(
    (paper) =>
      paper.status !== 'rejected' &&
      (paper.submissionType !== 'document' ||
        paper.evaluation?.status === 'completed')
  );
  if (!eligible.length) return null;

  const ranked = [...eligible].sort((left, right) => {
    const difference = (right.evaluation?.total || 0) - (left.evaluation?.total || 0);
    if (difference !== 0) return difference;
    return new Date(left.createdAt || 0) - new Date(right.createdAt || 0);
  });

  return ranked[0]._id ? ranked[0]._id.toString() : null;
}

module.exports = {
  CRITERIA,
  ENGINE,
  DIFFICULTY_TARGETS,
  COGNITIVE_TARGETS,
  evaluatePaper,
  recommendationFrom,
};
