import assert from 'node:assert/strict';
import test from 'node:test';

import { contentTypeFor, parseByteRange } from '../src/http/static-files.mjs';

test('static file MIME mapping is explicit and safe by default', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('photo.WEBP'), 'image/webp');
  assert.equal(contentTypeFor('unknown.bin'), 'application/octet-stream');
});

test('byte ranges support normal, open-ended and suffix forms', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=90-200', 100), { start: 90, end: 99 });
});

test('invalid or unsupported ranges are rejected without ambiguity', () => {
  assert.equal(parseByteRange('items=0-2', 100), null);
  assert.deepEqual(parseByteRange('bytes=100-101', 100), { invalid: true });
  assert.deepEqual(parseByteRange('bytes=50-40', 100), { invalid: true });
  assert.deepEqual(parseByteRange('bytes=-0', 100), { invalid: true });
  assert.equal(parseByteRange('bytes=0-1,4-5', 100), null);
});
