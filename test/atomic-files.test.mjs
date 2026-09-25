import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAtomicFileService } from '../src/fs/atomic-files.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let builds = 0;
  const service = createAtomicFileService({
    scheduleBuild: () => { builds += 1; },
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    relativeToRepo: (value) => path.relative(root, value).replaceAll('\\', '/'),
  });
  return { root, service, builds: () => builds };
}

test('atomicWrite replaces the destination and schedules by default', async (t) => {
  const { root, service, builds } = fixture(t);
  const target = path.join(root, 'data', 'value.txt');
  await service.atomicWrite(target, 'one');
  assert.equal(await fsp.readFile(target, 'utf8'), 'one');
  await service.atomicWrite(target, 'two');
  assert.equal(await fsp.readFile(target, 'utf8'), 'two');
  assert.equal(builds(), 2);
});

test('atomicWrite can suppress rebuild scheduling', async (t) => {
  const { root, service, builds } = fixture(t);
  const target = path.join(root, 'data', 'value.txt');
  await service.atomicWrite(target, 'one', { schedule: false });
  assert.equal(builds(), 0);
});

test('atomicCreate never overwrites an existing destination', async (t) => {
  const { root, service } = fixture(t);
  const target = path.join(root, 'asset.bin');
  await service.atomicCreate(target, Buffer.from('first'));
  await assert.rejects(() => service.atomicCreate(target, Buffer.from('second')), (error) => error.statusCode === 409);
  assert.equal(await fsp.readFile(target, 'utf8'), 'first');
});

test('copyWithoutClobber accepts an identical existing file but rejects conflicts', async (t) => {
  const { root, service } = fixture(t);
  const source = path.join(root, 'source.bin');
  const target = path.join(root, 'target.bin');
  await fsp.writeFile(source, 'same');
  await fsp.writeFile(target, 'same');
  assert.equal(await service.copyWithoutClobber(source, target), 'existing');
  await fsp.writeFile(source, 'different');
  await assert.rejects(() => service.copyWithoutClobber(source, target), (error) => error.statusCode === 409);
});


test('atomicWrite cleans staged files and preserves destination when rename fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-atomic-fault-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'data', 'value.txt');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, 'before');

  let builds = 0;
  let renameCalls = 0;
  const fsApi = new Proxy(fsp, {
    get(targetApi, key) {
      if (key !== 'rename') {
        const value = targetApi[key];
        return typeof value === 'function' ? value.bind(targetApi) : value;
      }
      return async (...args) => {
        renameCalls += 1;
        const error = Object.assign(new Error('injected rename failure'), { code: 'EPERM' });
        throw error;
      };
    },
  });

  const service = createAtomicFileService({
    scheduleBuild: () => { builds += 1; },
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    relativeToRepo: (value) => path.relative(root, value).replaceAll('\\', '/'),
    fsApi,
  });

  await assert.rejects(() => service.atomicWrite(target, 'after'), /injected rename failure/);
  assert.equal(renameCalls, 1);
  assert.equal(builds, 0);
  assert.equal(await fsp.readFile(target, 'utf8'), 'before');

  const staged = (await fsp.readdir(path.dirname(target))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(staged, []);
});
