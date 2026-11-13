const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  filePolicyMessage,
  metaFor,
} = require('../src/middleware/upload');

test('accepts MP4 class materials without changing existing upload limits', () => {
  assert.deepEqual(metaFor('Lecture.MP4'), {
    extension: '.mp4',
    mimeType: 'video/mp4',
    kind: 'video',
  });
  assert.ok(ALLOWED_EXTENSIONS.includes('.mp4'));
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.match(filePolicyMessage(), /\.mp4/);
});
