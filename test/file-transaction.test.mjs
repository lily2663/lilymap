import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAtomicFileService } from '../src/fs/atomic-files.mjs';
import { createFileTransactionService } from '../src/fs/file-transaction.mjs';

function fixture(t, fsApi = fsp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let builds = 0;
  const atomic = createAtomicFileService({
    scheduleBuild: () => { builds += 1; },
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
  });
  const transaction = createFileTransactionService({
    stageFile: atomic.stageFile,
    atomicWrite: atomic.atomicWrite,
    scheduleBuild: () => { builds += 1; },
    fsApi,
  });
  return { root, transaction, builds: () => builds };
}

test('file transaction replaces multiple files and schedules exactly once', async (t) => {
  const { root, transaction, builds } = fixture(t);
  const first = path.join(root, 'a.txt');
  const second = path.join(root, 'b.txt');
  await fsp.writeFile(first, 'old-a');
  await fsp.writeFile(second, 'old-b');

  const result = await transaction.replaceFiles([
    { target: first, content: 'new-a' },
    { target: second, content: 'new-b' },
  ]);

  assert.deepEqual(result, { changed: 2 });
  assert.equal(await fsp.readFile(first, 'utf8'), 'new-a');
  assert.equal(await fsp.readFile(second, 'utf8'), 'new-b');
  assert.equal(builds(), 1);
});

test('file transaction restores already committed files when a later rename fails', async (t) => {
  let renameCount = 0;
  const fsApi = new Proxy(fsp, {
    get(target, key) {
      const value = target[key];
      if (key !== 'rename') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args) => {
        renameCount += 1;
        if (renameCount === 2) {
          throw Object.assign(new Error('injected second rename failure'), { code: 'EPERM' });
        }
        return fsp.rename(...args);
      };
    },
  });

  const { root, transaction, builds } = fixture(t, fsApi);
  const first = path.join(root, 'a.txt');
  const second = path.join(root, 'b.txt');
  await fsp.writeFile(first, 'old-a');
  await fsp.writeFile(second, 'old-b');

  await assert.rejects(
    transaction.replaceFiles([
      { target: first, content: 'new-a' },
      { target: second, content: 'new-b' },
    ]),
    /injected second rename failure/,
  );

  assert.equal(await fsp.readFile(first, 'utf8'), 'old-a');
  assert.equal(await fsp.readFile(second, 'utf8'), 'old-b');
  assert.equal(builds(), 0);
  assert.deepEqual((await fsp.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('file transaction removes newly created targets during rollback', async (t) => {
  let renameCount = 0;
  const fsApi = new Proxy(fsp, {
    get(target, key) {
      const value = target[key];
      if (key !== 'rename') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args) => {
        renameCount += 1;
        if (renameCount === 2) throw Object.assign(new Error('stop'), { code: 'EIO' });
        return fsp.rename(...args);
      };
    },
  });

  const { root, transaction } = fixture(t, fsApi);
  const first = path.join(root, 'new-a.txt');
  const second = path.join(root, 'new-b.txt');

  await assert.rejects(transaction.replaceFiles([
    { target: first, content: 'a' },
    { target: second, content: 'b' },
  ]));

  assert.equal(await fsp.access(first).then(() => true).catch(() => false), false);
  assert.equal(await fsp.access(second).then(() => true).catch(() => false), false);
});
