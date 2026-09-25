import assert from 'node:assert/strict';
import test from 'node:test';

import { createHttpPrimitives } from '../src/http/primitives.mjs';

const http = createHttpPrimitives({ port: 5174, maxBodyBytes: 1024, maxDecodedImageBytes: 1024 * 1024 });

test('admin host and write origins are restricted to the local application', () => {
  assert.equal(http.adminHostAllowed({ headers: { host: 'localhost:5174' } }), true);
  assert.equal(http.adminHostAllowed({ headers: { host: '127.0.0.1:5174' } }), true);
  assert.equal(http.adminHostAllowed({ headers: { host: 'attacker.example:5174' } }), false);
  assert.equal(http.adminHostAllowed({ headers: {} }), false);
  assert.equal(http.adminOriginAllowed({ headers: {} }), true);
  assert.equal(http.adminOriginAllowed({ headers: { origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(http.adminOriginAllowed({ headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' } }), false);
});

test('static security policy distinguishes HTML from inert resources', () => {
  const htmlPolicy = http.staticSecurityHeaders('index.html')['content-security-policy'];
  assert.match(htmlPolicy, /script-src 'self'/);
  assert.doesNotMatch(htmlPolicy, /script-src[^;]*unsafe-inline/);
  assert.match(http.staticSecurityHeaders('image.svg')['content-security-policy'], /sandbox/);
});

test('image signature validation rejects extension spoofing', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(http.hasExpectedImageSignature(jpeg, '.jpg'), true);
  assert.equal(http.hasExpectedImageSignature(jpeg, '.png'), false);
});

test('HTTP errors retain their response status', () => {
  assert.equal(http.httpError(409, 'conflict').statusCode, 409);
});
