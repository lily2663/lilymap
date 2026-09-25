import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAtomicFileService } from '../src/fs/atomic-files.mjs';
import { createImportService } from '../src/services/import-service.mjs';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function fixture(t, plan) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-import-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contentRoot = path.join(root, 'content');
  const trashRoot = path.join(root, '.admin-trash');
  await fsp.mkdir(path.join(contentRoot, 'posts'), { recursive: true });
  let builds = 0;
  const atomic = createAtomicFileService({
    scheduleBuild: () => { builds += 1; },
    httpError,
  });
  const service = createImportService({
    repoRoot: root,
    contentRoot,
    trashRoot,
    uploadImageExtensions: new Set(['.png']),
    prepareImport: async () => plan,
    hasExpectedImageSignature: () => true,
    atomicWrite: atomic.atomicWrite,
    atomicCreate: atomic.atomicCreate,
    copyWithoutClobber: atomic.copyWithoutClobber,
    scheduleBuild: () => { builds += 1; },
    httpError,
  });
  return { root, contentRoot, trashRoot, service, builds: () => builds };
}

test('import service commits a Page Bundle and schedules once', async (t) => {
  const plan = {
    slug: 'hello',
    raw: '---\ntitle: Hello\n---\nBody',
    assets: [{ targetParts: ['shot.png'], content: Buffer.from('png').toString('base64') }],
    staticCopies: [],
    missing: [],
    rewrites: [],
  };
  const { contentRoot, service, builds } = await fixture(t, plan);
  const result = await service.importRequest({});
  assert.equal(result.path, 'content/posts/hello/index.md');
  assert.equal(await fsp.readFile(path.join(contentRoot, 'posts', 'hello', 'index.md'), 'utf8'), plan.raw);
  assert.equal(await fsp.readFile(path.join(contentRoot, 'posts', 'hello', 'shot.png'), 'utf8'), 'png');
  assert.equal(builds(), 1);
});

test('import service restores public files and removes newly copied static assets after failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-import-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.png');
  const second = path.join(root, 'second.png');
  await fsp.writeFile(source, 'new-one');
  await fsp.writeFile(second, 'new-two');
  await fsp.mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  await fsp.writeFile(path.join(root, 'public', 'assets', 'one.png'), 'old-public');

  const plan = {
    slug: 'broken',
    raw: 'body',
    assets: [],
    staticCopies: [
      { from: source, to: 'static/assets/one.png' },
      { from: second, to: 'static/assets/two.png' },
    ],
    missing: [],
    rewrites: [],
  };

  const atomic = createAtomicFileService({ scheduleBuild: () => {}, httpError });
  let writes = 0;
  const service = createImportService({
    repoRoot: root,
    contentRoot: path.join(root, 'content'),
    trashRoot: path.join(root, '.admin-trash'),
    uploadImageExtensions: new Set(['.png']),
    prepareImport: async () => plan,
    hasExpectedImageSignature: () => true,
    atomicWrite: async (target, content, options) => {
      writes += 1;
      if (writes === 3) throw new Error('injected public write failure');
      return atomic.atomicWrite(target, content, options);
    },
    atomicCreate: atomic.atomicCreate,
    copyWithoutClobber: atomic.copyWithoutClobber,
    scheduleBuild: () => {},
    httpError,
  });

  await assert.rejects(() => service.importRequest({}), /injected public write failure/);
  assert.equal(await fsp.readFile(path.join(root, 'public', 'assets', 'one.png'), 'utf8'), 'old-public');
  assert.equal(await fsp.access(path.join(root, 'static', 'assets', 'one.png')).then(() => true).catch(() => false), false);
  assert.equal(await fsp.access(path.join(root, 'static', 'assets', 'two.png')).then(() => true).catch(() => false), false);
  assert.equal(await fsp.access(path.join(root, 'content', 'posts', 'broken')).then(() => true).catch(() => false), false);
});

test('import service refuses existing destination before touching files', async (t) => {
  const plan = { slug: 'exists', raw: 'body', assets: [], staticCopies: [], missing: [], rewrites: [] };
  const { contentRoot, service, builds } = await fixture(t, plan);
  await fsp.mkdir(path.join(contentRoot, 'posts', 'exists'));
  await assert.rejects(() => service.importRequest({}), (error) => error.statusCode === 409);
  assert.equal(builds(), 0);
});
