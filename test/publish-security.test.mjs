import assert from 'node:assert/strict';
import test from 'node:test';

import { redactGitCredentials, validatePublishToken } from '../src/domain/publish-security.mjs';

test('publish tokens are trimmed and constrained to the accepted format', () => {
  const token = 'ghp_123456789012345678901234567890';
  assert.equal(validatePublishToken(` ${token} `), token);
  assert.equal(validatePublishToken('short'), null);
  assert.equal(validatePublishToken(`${token}-invalid`), null);
  assert.equal(validatePublishToken(`a${'b'.repeat(2048)}`), null);
});

test('Git failure details redact literal tokens and tokenized GitHub URLs', () => {
  const token = 'ghp_123456789012345678901234567890';
  const detail = redactGitCredentials(`fatal: ${token}\nremote: https://oauth2:${token}@github.com/lily/site.git`, token);
  assert.doesNotMatch(detail, new RegExp(token));
  assert.match(detail, /https:\/\/\[REDACTED\]@github\.com/);
});
