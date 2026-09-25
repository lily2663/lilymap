import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createResourceService } from '../src/services/resource-service.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contentRoot = path.join(root, 'content');
  const staticRoot = path.join(root, 'static');
  const siteAssetsRoot = path.join(staticRoot, 'assets');
  const trashRoot = path.join(root, '.admin-trash');
  let builds = 0;
  const service = createResourceService({
    repoRoot: root,
    contentRoot,
    staticRoot,
    siteAssetsRoot,
    trashRoot,
    uploadImageExtensions: new Set(['.png', '.jpg']),
    mediaKind: (target) => /\.mp4$/i.test(target) ? 'video' : /\.(png|jpg)$/i.test(target) ? 'image' : 'other',
    hasExpectedImageSignature: () => true,
    atomicCreate: async (target, bytes) => {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes, { flag: 'wx' });
    },
    atomicWrite: async (target, bytes) => {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      builds += 1;
    },
    scheduleBuild: () => { builds += 1; },
    syncStaticPreview: async () => ({ previewSynced: true, warning: '' }),
    inspectMedia: async () => ({ width: 1920, height: 1080 }),
    ...overrides,
  });
  return { root, contentRoot, staticRoot, siteAssetsRoot, trashRoot, service, builds: () => builds };
}

test('resource service rejects extension changes and paths outside managed roots', async (t) => {
  const { root, siteAssetsRoot, service } = fixture(t);
  const target = path.join(siteAssetsRoot, 'img', 'photo.png');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, 'image');

  await assert.rejects(
    service.mutateFile({ method: 'PATCH', relativePath: 'static/assets/img/photo.png', name: '../evil.png' }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    service.mutateFile({ method: 'PATCH', relativePath: 'static/assets/img/photo.png', name: 'photo.jpg' }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    service.mutateFile({ method: 'DELETE', relativePath: '../outside.png' }),
    (error) => error.statusCode === 404,
  );
  assert.equal(await fsp.readFile(target, 'utf8'), 'image');
  assert.equal(await fsp.access(path.join(root, 'evil.png')).then(() => true).catch(() => false), false);
});

test('resource replacement restores the original file when the write fails', async (t) => {
  let writes = 0;
  const fixtureData = fixture(t, {
    atomicWrite: async (target, bytes) => {
      writes += 1;
      if (writes === 1) throw new Error('injected write failure');
      await fsp.writeFile(target, bytes);
    },
  });
  const target = path.join(fixtureData.siteAssetsRoot, 'img', 'photo.png');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, 'before');

  await assert.rejects(
    fixtureData.service.mutateFile({
      method: 'PUT',
      relativePath: 'static/assets/img/photo.png',
      bytes: Buffer.from('after'),
    }),
    /injected write failure/,
  );

  assert.equal(await fsp.readFile(target, 'utf8'), 'before');
});

test('resource listing exposes public paths only for static files', async (t) => {
  const { root, staticRoot, contentRoot, service } = fixture(t);
  await fsp.mkdir(path.join(staticRoot, 'assets', 'img'), { recursive: true });
  await fsp.mkdir(path.join(contentRoot, 'posts', 'hello'), { recursive: true });
  await fsp.writeFile(path.join(staticRoot, 'assets', 'img', 'photo.png'), 'x');
  await fsp.writeFile(path.join(contentRoot, 'posts', 'hello', 'shot.png'), 'x');
  await fsp.mkdir(path.join(root, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(root, 'assets', 'source.png'), 'x');

  const files = await service.listFiles();
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.equal(byPath['static/assets/img/photo.png'].publicPath, '/assets/img/photo.png');
  assert.equal(byPath['content/posts/hello/shot.png'].publicPath, null);
  assert.equal(byPath['assets/source.png'].scope, 'pipeline');
});
