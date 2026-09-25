import assert from 'node:assert/strict';
import test from 'node:test';

import { safeSlug } from '../src/domain/slug.mjs';
import { createImportPlanner } from '../src/services/import-planner.mjs';

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const planner = createImportPlanner({
  repoRoot: process.cwd(),
  uploadImageExtensions: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']),
  hasExpectedImageSignature: () => true,
  httpError,
  now: () => new Date('2026-09-25T00:00:00.000Z'),
});

function encoded(name, content, relativePath = name) {
  return { name, relativePath, content: Buffer.from(content).toString('base64') };
}

test('safeSlug rejects traversal and filesystem-special characters', () => {
  assert.equal(safeSlug('hello world'), 'hello-world');
  for (const value of ['', '..', '../post', 'a/b', 'a\\b', 'a:b', 'a..b']) assert.equal(safeSlug(value), null);
});

test('import planner creates front matter and matches relative bundle images', async () => {
  const plan = await planner({
    files: [
      encoded('post.md', '# Hello\n\n![shot](images/shot.png)', 'bundle/post.md'),
      encoded('shot.png', 'fake-image', 'bundle/images/shot.png'),
    ],
    draft: false,
  });
  assert.equal(plan.slug, 'post');
  assert.equal(plan.assets.length, 1);
  assert.deepEqual(plan.assets[0].targetParts, ['images', 'shot.png']);
  assert.deepEqual(plan.missing, []);
  assert.match(plan.raw, /date: 2026-09-25T00:00:00\.000Z/);
  assert.match(plan.raw, /draft: false/);
});

test('import planner reports missing relative images without inventing files', async () => {
  const plan = await planner({
    files: [encoded('post.md', '![missing](images/missing.png)')],
  });
  assert.deepEqual(plan.missing, ['images/missing.png']);
});

test('import planner rejects duplicate target paths case-insensitively', async () => {
  await assert.rejects(() => planner({
    files: [
      encoded('post.md', '![a](image.png)'),
      encoded('image.png', 'one'),
      encoded('IMAGE.PNG', 'two'),
    ],
  }), (error) => error.statusCode === 409);
});
