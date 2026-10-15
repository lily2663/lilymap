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

test('generated responsive images are listed as generated and cannot be edited or uploaded', async (t) => {
  const { staticRoot, service, builds } = fixture(t);
  const relativePath = 'static/assets/img/responsive/photo-480.png';
  const target = path.join(staticRoot, 'assets', 'img', 'responsive', 'photo-480.png');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, 'generated');
  const files = await service.listFiles();
  assert.equal(files.find((file) => file.path === relativePath).generated, true);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(service.mutateFile({ method, relativePath, name: 'other.png', bytes: Buffer.from('changed') }), (error) => error.statusCode === 404);
  }
  await assert.rejects(service.uploadAsset({ name: 'other.png', area: 'static/assets/img/responsive', bytes: Buffer.from('new') }), (error) => error.statusCode === 400);
  assert.equal(await fsp.readFile(target, 'utf8'), 'generated');
  assert.equal(builds(), 0);
});

test('generated images remain protected through internal directory junction aliases and absent upload subdirectories', async (t) => {
  const { staticRoot, service, builds } = fixture(t);
  const imageRoot = path.join(staticRoot, 'assets', 'img');
  const generatedRoot = path.join(imageRoot, 'responsive');
  const target = path.join(generatedRoot, 'photo.png');
  await fsp.mkdir(generatedRoot, { recursive: true });
  await fsp.writeFile(target, 'generated');
  try { await fsp.symlink(generatedRoot, path.join(imageRoot, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory junctions or symlinks are unavailable on this host.'); return; }
    throw error;
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(service.mutateFile({
      method, relativePath: 'static/assets/img/alias/photo.png', name: 'other.png', bytes: Buffer.from('changed'),
    }), (error) => error.statusCode === 404);
  }
  for (const area of ['static/assets/img/alias', 'static/assets/img/alias/new/subdirectory']) {
    await assert.rejects(service.uploadAsset({ name: 'other.png', area, bytes: Buffer.from('new') }), (error) => error.statusCode === 400);
  }
  assert.equal(await fsp.readFile(target, 'utf8'), 'generated');
  assert.equal(await fsp.access(path.join(generatedRoot, 'new')).then(() => true).catch(() => false), false);
  const files = await service.listFiles();
  assert.equal(files.find((file) => file.path === 'static/assets/img/responsive/photo.png').generated, true);
  assert.equal(builds(), 0);
});

test('resource listings mark the actual generated store when responsive itself is an internal junction', async (t) => {
  const { staticRoot, service } = fixture(t);
  const imageRoot = path.join(staticRoot, 'assets', 'img');
  const store = path.join(imageRoot, 'generated-store');
  await fsp.mkdir(store, { recursive: true });
  await fsp.writeFile(path.join(store, 'photo.png'), 'generated');
  try { await fsp.symlink(store, path.join(imageRoot, 'responsive'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory junctions or symlinks are unavailable on this host.'); return; }
    throw error;
  }
  const files = await service.listFiles();
  assert.equal(files.find((file) => file.path === 'static/assets/img/generated-store/photo.png').generated, true);
  await assert.rejects(service.mutateFile({ method: 'DELETE', relativePath: 'static/assets/img/generated-store/photo.png' }), (error) => error.statusCode === 404);
});
