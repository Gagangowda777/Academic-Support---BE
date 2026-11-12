const assert = require('node:assert/strict');
const test = require('node:test');
const { extractDocumentText } = require('../src/services/documentTextExtractor');

test('extracts text from generated session-resource PDFs with the current parser', async () => {
  const result = await extractDocumentText({
    storedName: 'seed-CS501-2026-11-05.pdf',
    originalName: 'CS501-indexing-and-query-plans.pdf',
  });

  assert.match(result.text, /Core ideas/i);
  assert.match(result.text, /composite index/i);
});
