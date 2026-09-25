import assert from 'node:assert/strict';
import test from 'node:test';

import { isSensitivePublishPath, redactGitCredentials, validatePublishToken } from '../src/domain/publish-security.mjs';

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

test('publish safety rejects local secret and recovery paths', () => {
  for (const path of ['.token', '.secrets/protected-posts.json', 'private-content/draft.md', '.lilymap-local.json', '.admin-trash/old.md', '.backups/layout.yaml', 'lilymap.json']) {
    assert.equal(isSensitivePublishPath(path), true, path);
  }
  for (const path of ['content/posts/hello/index.md', 'static/assets/img/avatar.webp', '.github/workflows/hugo.yaml']) {
    assert.equal(isSensitivePublishPath(path), false, path);
  }
});
