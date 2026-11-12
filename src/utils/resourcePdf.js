const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_HEIGHT = 46;

const COLORS = {
  ink: rgb(0.06, 0.09, 0.16),
  navy: rgb(0.118, 0.165, 0.42),
  muted: rgb(0.42, 0.48, 0.57),
  rule: rgb(0.88, 0.91, 0.96),
  accent: rgb(0.145, 0.388, 0.921),
};

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

// Standard fonts use WinAnsi encoding, which cannot encode every Unicode glyph.
function toWinAnsi(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

function wrapText(value, font, size, maxWidth) {
  const lines = [];

  for (const paragraph of toWinAnsi(value).split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;

      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }

    if (current) lines.push(current);
  }

  return lines;
}

/**
 * Renders a single session's resource as a PDF so it can be downloaded as a
 * real file. Content is generated from the stored resource record, so no
 * filesystem or object storage is required.
 */
async function buildSessionResourcePdf({ session, student, resource }) {
  const doc = await PDFDocument.create();
  const bodyFont = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await doc.embedFont(StandardFonts.HelveticaOblique);

  doc.setTitle(toWinAnsi(resource.title || session.topic));
  doc.setAuthor('Transcend Group of Institutions');
  doc.setSubject(toWinAnsi(`${session.courseCode} - ${session.topic}`));
  doc.setCreator('Campus Portal');

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  const write = (
    value,
    { font = bodyFont, size = 11, color = COLORS.ink, leading = size * 1.5, gapAfter = 0 } = {}
  ) => {
    for (const line of wrapText(value, font, size, CONTENT_WIDTH)) {
      if (y - leading < MARGIN + FOOTER_HEIGHT) newPage();
      y -= leading;
      if (line) {
        page.drawText(line, { x: MARGIN, y, size, font, color });
      }
    }
    y -= gapAfter;
  };

  const rule = (gapBefore = 10, gapAfter = 12) => {
    y -= gapBefore;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.8,
      color: COLORS.rule,
    });
    y -= gapAfter;
  };

  page.drawRectangle({
    x: MARGIN,
    y: y - 4,
    width: 42,
    height: 4,
    color: COLORS.accent,
  });

  write('TRANSCEND GROUP OF INSTITUTIONS', {
    font: boldFont,
    size: 8.5,
    color: COLORS.muted,
    leading: 26,
    gapAfter: 2,
  });

  write(resource.title || session.topic, {
    font: boldFont,
    size: 22,
    color: COLORS.navy,
    leading: 28,
    gapAfter: 10,
  });

  write(`${session.courseName} (${session.courseCode})`, {
    font: boldFont,
    size: 11.5,
    color: COLORS.ink,
    leading: 17,
  });
  write(`Faculty: ${session.facultyName}`, { size: 10.5, color: COLORS.muted, leading: 16 });
  write(
    `Session: ${DATE_FORMAT.format(new Date(session.date))} | ${session.startTime} - ${session.endTime}${
      session.room ? ` | ${session.room}` : ''
    }`,
    { size: 10.5, color: COLORS.muted, leading: 16 }
  );
  write(`Topic: ${session.topic}`, { size: 10.5, color: COLORS.muted, leading: 16 });

  rule(14, 16);

  write('SESSION NOTES', {
    font: boldFont,
    size: 9,
    color: COLORS.accent,
    leading: 16,
    gapAfter: 6,
  });

  const notes = resource.body || resource.summary || 'No notes were attached to this session.';
  write(notes, { size: 11, leading: 17, gapAfter: 8 });

  if (resource.summary && resource.body) {
    rule(12, 14);
    write('IN ONE LINE', {
      font: boldFont,
      size: 9,
      color: COLORS.accent,
      leading: 16,
      gapAfter: 4,
    });
    write(resource.summary, { font: italicFont, size: 10.5, color: COLORS.muted, leading: 16 });
  }

  const downloadedBy = `${student.name}${
    student.enrollmentId ? ` (${student.enrollmentId})` : ''
  } - ${DATE_FORMAT.format(new Date())}`;
  const pages = doc.getPages();

  pages.forEach((current, index) => {
    current.drawLine({
      start: { x: MARGIN, y: MARGIN + 24 },
      end: { x: PAGE_WIDTH - MARGIN, y: MARGIN + 24 },
      thickness: 0.8,
      color: COLORS.rule,
    });
    current.drawText(toWinAnsi('Campus Portal | Resource for a session you were marked absent in'), {
      x: MARGIN,
      y: MARGIN + 12,
      size: 8,
      font: bodyFont,
      color: COLORS.muted,
    });
    current.drawText(toWinAnsi(downloadedBy), {
      x: MARGIN,
      y: MARGIN,
      size: 8,
      font: bodyFont,
      color: COLORS.muted,
    });
    current.drawText(toWinAnsi(`Page ${index + 1} of ${pages.length}`), {
      x: PAGE_WIDTH - MARGIN - 46,
      y: MARGIN,
      size: 8,
      font: bodyFont,
      color: COLORS.muted,
    });
  });

  return Buffer.from(await doc.save());
}

module.exports = { buildSessionResourcePdf };
