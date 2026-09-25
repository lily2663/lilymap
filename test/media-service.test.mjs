import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMediaService } from '../src/services/media-service.mjs';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function signature(bytes, ext) {
  if (ext === '.png') return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return true;
}

test('media service imports images without invoking FFmpeg', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'wall.png');
  await fsp.writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  let processCalls = 0;
  const service = createMediaService({
    repoRoot: root,
    siteAssetsRoot: path.join(root, 'static', 'assets'),
    hugoPublicRoot: path.join(root, 'public'),
    uploadImageExtensions: new Set(['.png']),
    uploadVideoExtensions: new Set(['.mp4']),
    mediaTargetNames: new Map([['welcome', 'day']]),
    hasExpectedImageSignature: signature,
    httpError,
    atomicCreate: async (target, bytes) => {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes, { flag: 'wx' });
    },
    scheduleBuild: () => {},
    processRunner: { run: async () => { processCalls += 1; return { code: 0, stdout: '', stderr: '' }; } },
  });

  const result = await service.importWallpaperMedia(source, 'welcome');
  assert.equal(result.kind, 'image');
  assert.equal(result.optimized, false);
  assert.equal(processCalls, 0);
  assert.ok(result.path.startsWith('/assets/img/wallpapers/day-wallpaper-'));
  assert.equal(result.previewSynced, true);
});

test('media service cleans temporary output when FFmpeg times out', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'wall.mp4');
  await fsp.writeFile(source, 'fake-video');
  const calls = [];
  const service = createMediaService({
    repoRoot: root,
    siteAssetsRoot: path.join(root, 'static', 'assets'),
    hugoPublicRoot: path.join(root, 'public'),
    uploadImageExtensions: new Set(['.png']),
    uploadVideoExtensions: new Set(['.mp4']),
    mediaTargetNames: new Map([['welcome', 'day']]),
    hasExpectedImageSignature: () => true,
    httpError,
    atomicCreate: async () => {},
    scheduleBuild: () => {},
    processRunner: {
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === '-version') return { code: 0, stdout: command.includes('ffmpeg') ? 'ffmpeg version test\n' : 'ffprobe version test\n', stderr: '' };
        if (command.includes('ffprobe')) {
          return { code: 0, stdout: JSON.stringify({ streams: [{ codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1' }], format: { duration: '10', size: '100', format_name: 'mp4' } }), stderr: '' };
        }
        return { code: 1, stdout: '', stderr: '', timedOut: true, output: '', error: 'timeout' };
      },
    },
  });

  await assert.rejects(
    () => service.importWallpaperMedia(source, 'welcome'),
    (error) => error.statusCode === 504 && /180 秒/.test(error.message),
  );

  const wallpaperDir = path.join(root, 'static', 'assets', 'media', 'wallpapers');
  const leftovers = await fsp.readdir(wallpaperDir).catch(() => []);
  assert.deepEqual(leftovers.filter((name) => name.includes('.tmp.')), []);
  assert.ok(calls.some(({ command }) => command.includes('ffmpeg')));
});

test('uploaded video temporary source is always removed after import failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createMediaService({
    repoRoot: root,
    siteAssetsRoot: path.join(root, 'static', 'assets'),
    hugoPublicRoot: path.join(root, 'public'),
    uploadImageExtensions: new Set(['.png']),
    uploadVideoExtensions: new Set(['.mp4']),
    mediaTargetNames: new Map([['welcome', 'day']]),
    hasExpectedImageSignature: () => true,
    httpError,
    atomicCreate: async () => {},
    scheduleBuild: () => {},
    processRunner: { run: async () => ({ code: 1, stdout: '', stderr: 'missing tool' }) },
  });

  await assert.rejects(() => service.importUploadedVideo({
    name: 'clip.mp4',
    bytes: Buffer.from('video'),
    targetName: 'welcome',
  }));

  const tempRoot = path.join(root, '.admin-tmp');
  const leftovers = await fsp.readdir(tempRoot).catch(() => []);
  assert.deepEqual(leftovers, []);
});
