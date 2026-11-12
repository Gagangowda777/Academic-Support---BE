const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const TEXT = rgb(0.13, 0.19, 0.28);
const MUTED = rgb(0.42, 0.49, 0.6);
const ACCENT = rgb(0.14, 0.36, 0.68);
const RULE = rgb(0.84, 0.89, 0.95);

function pdfText(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u201a\u2039\u203a]/g, "'")
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2022/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2000-\u200b]/g, ' ')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function fitText(font, text, size, maxWidth) {
  const clean = pdfText(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;

  let fitted = clean;
  while (fitted.length > 0 && font.widthOfTextAtSize(`${fitted}...`, size) > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted.trimEnd()}...`;
}

function wrapText(text, font, size, maxWidth) {
  const lines = [];

  for (const paragraph of pdfText(text).split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }

    let line = '';
    for (let word of words) {
      while (font.widthOfTextAtSize(word, size) > maxWidth) {
        if (line) {
          lines.push(line);
          line = '';
        }
        let splitAt = word.length;
        while (
          splitAt > 1 &&
          font.widthOfTextAtSize(word.slice(0, splitAt), size) > maxWidth
        ) {
          splitAt -= 1;
        }
        lines.push(word.slice(0, splitAt));
        word = word.slice(splitAt);
      }

      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }

  return lines.length ? lines : [''];
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

function createWriter(document, fonts, title) {
  const pages = [];
  let page;
  let y = 0;

  function newPage() {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    page.drawText(fitText(fonts.bold, title, 8, PAGE_WIDTH - MARGIN * 2), {
      x: MARGIN,
      y: PAGE_HEIGHT - 34,
      size: 8,
      font: fonts.bold,
      color: MUTED,
    });
    page.drawLine({
      start: { x: MARGIN, y: PAGE_HEIGHT - 44 },
      end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 44 },
      thickness: 0.7,
      color: RULE,
    });
    y = PAGE_HEIGHT - 66;
  }

  function ensureSpace(height) {
    if (y - height < MARGIN + 18) newPage();
  }

  function heading(text, size = 15) {
    const lineHeight = size * 1.3;
    ensureSpace(lineHeight + 10);
    y -= 5;
    page.drawText(fitText(fonts.bold, text, size, PAGE_WIDTH - MARGIN * 2), {
      x: MARGIN,
      y,
      size,
      font: fonts.bold,
      color: ACCENT,
    });
    y -= lineHeight + 4;
  }

  function paragraph(text, { size = 10, color = TEXT, indent = 0, spacing = 4 } = {}) {
    const maxWidth = PAGE_WIDTH - MARGIN * 2 - indent;
    const lineHeight = size * 1.48;
    for (const line of wrapText(text, fonts.body, size, maxWidth)) {
      ensureSpace(lineHeight);
      if (line) {
        page.drawText(line, {
          x: MARGIN + indent,
          y,
          size,
          font: fonts.body,
          color,
        });
      }
      y -= lineHeight;
    }
    y -= spacing;
  }

  function meta(text) {
    const size = 8.5;
    const lineHeight = size * 1.45;
    ensureSpace(lineHeight);
    paragraph(text, { size, color: MUTED, spacing: 2 });
  }

  function listItem(text, marker = '-') {
    const prefix = `${marker} `;
    const width = fonts.body.widthOfTextAtSize(prefix, 10);
    const lines = wrapText(text, fonts.body, 10, PAGE_WIDTH - MARGIN * 2 - 14);
    const lineHeight = 10 * 1.48;

    lines.forEach((line, index) => {
      ensureSpace(lineHeight);
      if (index === 0) {
        page.drawText(prefix, {
          x: MARGIN + 5,
          y,
          size: 10,
          font: fonts.body,
          color: ACCENT,
        });
      }
      if (line) {
        page.drawText(line, {
          x: MARGIN + 5 + width,
          y,
          size: 10,
          font: fonts.body,
          color: TEXT,
        });
      }
      y -= lineHeight;
    });
    y -= 2;
  }

  function rule() {
    ensureSpace(14);
    y -= 3;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.7,
      color: RULE,
    });
    y -= 11;
  }

  function finish() {
    const total = pages.length;
    pages.forEach((current, index) => {
      current.drawText(`Page ${index + 1} of ${total}`, {
        x: PAGE_WIDTH - MARGIN - 52,
        y: 24,
        size: 7.5,
        font: fonts.body,
        color: MUTED,
      });
    });
  }

  newPage();
  return { heading, paragraph, meta, listItem, rule, finish };
}

function writeAnalysis(writer, analysis) {
  const recurringTopics = Array.isArray(analysis?.recurringTopics)
    ? analysis.recurringTopics
    : [];
  if (recurringTopics.length) {
    writer.heading('Recurring topics in past papers', 12);
    recurringTopics.forEach((topic) => {
      const years = Array.isArray(topic.years) ? topic.years.join(', ') : '';
      writer.listItem(
        `${topic.topic} - ${topic.unit} (${topic.frequency} paper${
          topic.frequency === 1 ? '' : 's'
        }${years ? `, ${years}` : ''})`
      );
    });
  }

  [
    ['Observed patterns', analysis?.patterns],
    ['Recommendations', analysis?.recommendations],
    ['Coverage gaps', analysis?.coverageGaps],
  ].forEach(([label, items]) => {
    if (!Array.isArray(items) || !items.length) return;
    writer.heading(label, 12);
    items.forEach((item) => writer.listItem(item));
  });
}

function subjectLine(bank) {
  return [
    bank.subject?.code,
    bank.subject?.name,
    bank.exam?.name,
  ]
    .filter(Boolean)
    .join(' | ');
}

async function createDocument(title) {
  const document = await PDFDocument.create();
  const fonts = {
    body: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
  };
  document.setTitle(title);
  document.setProducer('Campus Portal');
  document.setCreator('Campus Portal');
  return { document, fonts };
}

async function buildQuestionBankPdf({ bank }) {
  const { document, fonts } = await createDocument(bank.title || 'Question bank');
  const writer = createWriter(document, fonts, 'Campus Portal - Question bank');

  writer.heading(bank.title || 'Question bank', 20);
  writer.meta(subjectLine(bank));
  writer.meta(
    [
      `Generated ${formatDate(bank.createdAt)}`,
      bank.engine,
      `${bank.questions?.length || 0} questions`,
    ]
      .filter(Boolean)
      .join(' | ')
  );
  writer.rule();

  if (bank.analysis?.summary) {
    writer.heading('Overview', 13);
    writer.paragraph(bank.analysis.summary);
  }

  const notes = bank.sources?.notes || [];
  if (notes.length) {
    writer.heading('Source class notes', 13);
    notes.forEach((note) =>
      writer.listItem(
        `${note.name}${note.sessionTopic ? ` - ${note.sessionTopic}` : ''}`
      )
    );
  }

  const questions = Array.isArray(bank.questions) ? bank.questions : [];
  writer.heading(`Practice questions (${questions.length})`, 13);
  questions.forEach((question, index) => {
    writer.heading(`Question ${index + 1} - ${question.marks} marks`, 11.5);
    writer.meta(
      [question.unit, question.difficulty, question.cognitive]
        .filter(Boolean)
        .join(' | ')
    );
    writer.paragraph(question.text);

    if (question.answerKey) {
      writer.heading('Answer guide', 9.5);
      writer.paragraph(question.answerKey, { size: 9.5, color: MUTED });
    }
    writer.rule();
  });

  writeAnalysis(writer, bank.analysis);
  writer.finish();

  return Buffer.from(await document.save());
}

async function buildPastPaperAnalysisPdf({ analysis }) {
  const title = 'Five-Year Past-Paper Analysis';
  const { document, fonts } = await createDocument(title);
  const writer = createWriter(document, fonts, 'Campus Portal - Past-paper analysis');

  writer.heading(title, 20);
  writer.meta(
    [analysis.subject?.code, analysis.subject?.name, analysis.exam?.name]
      .filter(Boolean)
      .join(' | ')
  );
  writer.meta(
    [
      analysis.papers?.length
        ? `Papers: ${analysis.papers.map((paper) => paper.year).join(', ')}`
        : '',
      analysis.updatedAt ? `Updated ${formatDate(analysis.updatedAt)}` : '',
      analysis.engine,
    ]
      .filter(Boolean)
      .join(' | ')
  );
  writer.rule();

  if (analysis.analysis?.summary) {
    writer.heading('Overview', 13);
    writer.paragraph(analysis.analysis.summary);
  }

  if (analysis.papers?.length) {
    writer.heading('Papers analysed', 13);
    analysis.papers.forEach((paper) =>
      writer.listItem(`${paper.year} - ${paper.name}`)
    );
  }

  writeAnalysis(writer, analysis.analysis);
  writer.finish();

  return Buffer.from(await document.save());
}

module.exports = {
  buildQuestionBankPdf,
  buildPastPaperAnalysisPdf,
  pdfText,
};
