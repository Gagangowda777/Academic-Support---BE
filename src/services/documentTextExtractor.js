const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { UPLOAD_DIR } = require('../middleware/upload');

const configuredTextLimit = Number(process.env.PAPER_AI_MAX_TEXT_CHARS);
const MAX_EXTRACTED_TEXT_CHARS =
  Number.isFinite(configuredTextLimit) && configuredTextLimit > 0
    ? Math.min(configuredTextLimit, 500000)
    : 60000;

function documentPath(storedName) {
  const root = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(root, String(storedName || ''));

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid uploaded document reference');
  }

  return filePath;
}

async function extractPdfText(buffer) {
  try {
    const parsed = await pdfParse(buffer, { version: 'v2.0.550' });
    return parsed.text;
  } catch (error) {
    if (error.name !== 'InvalidPDFException') throw error;

    const document = await PDFDocument.load(buffer);
    const normalizedBuffer = Buffer.from(await document.save());
    const parsed = await pdfParse(normalizedBuffer, { version: 'v2.0.550' });
    return parsed.text;
  }
}

async function extractDocumentText(document, { required = true } = {}) {
  if (!document?.storedName) {
    if (required) throw new Error('The uploaded question paper is missing');
    return { text: '', truncated: false };
  }

  const extension = path.extname(document.originalName || '').toLowerCase();
  const buffer = await fs.readFile(documentPath(document.storedName));
  let text;

  if (extension === '.pdf') {
    text = await extractPdfText(buffer);
  } else if (extension === '.docx') {
    const parsed = await mammoth.extractRawText({ buffer });
    text = parsed.value;
  } else {
    throw new Error(`Unsupported question-paper format: ${extension || 'unknown'}`);
  }

  text = String(text || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!text && required) {
    throw new Error(
      'No selectable text was found in the document. Scanned PDFs need OCR before upload.'
    );
  }

  const truncated = text.length > MAX_EXTRACTED_TEXT_CHARS;
  return {
    text: truncated
      ? `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n[Text truncated for local model context.]`
      : text,
    truncated,
  };
}

module.exports = { extractDocumentText, MAX_EXTRACTED_TEXT_CHARS };
