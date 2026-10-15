import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createImageOptimizationService } from '../src/services/image-optimization-service.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const successfulResult = { code: 0, output: 'Responsive images complete.\n' };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lilymap-image-optimization-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts/optimize-images.mjs'), '// Test fixture, never executed.\n');
  const calls = [];
  let builds = 0;
  const service = createImageOptimizationService({
    repoRoot: root,
    processRunner: { run: async (...args) => { calls.push(args); return successfulResult; } },
    scheduleBuild: () => { builds += 1; },
    ...options,
  });
  return { root, service, calls, builds: () => builds };
}

function webp(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8X', 8);
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

async function writeManifest(root, images) {
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/image_variants.json'), JSON.stringify({ version: 1, images }));
}

async function imageFixture(root) {
  const source = Buffer.alloc(1024, 7);
  const candidate = webp(480, 240);
  const url = '/assets/img/photo.png';
  const candidateUrl = '/assets/img/responsive/photo-480w.webp';
  await fs.mkdir(path.join(root, 'static/assets/img/responsive'), { recursive: true });
  await fs.writeFile(path.join(root, `static${url}`), source);
  await fs.writeFile(path.join(root, `static${candidateUrl}`), candidate);
  return {
    url, source, candidate, candidateUrl,
    image: { sha256: digest(source), width: 960, height: 480,
      candidates: [{ url: candidateUrl, width: 480, height: 240, bytes: candidate.length }] },
  };
}

test('standalone projects explicitly report unavailable without spawning a process', async (t) => {
  const { root, service, calls } = await fixture(t);
  await fs.rm(path.join(root, 'scripts/optimize-images.mjs'));
  const before = await service.snapshot();
  assert.equal(before.supported, false);
  assert.match(before.reason, /未提供/);
  assert.equal(before.manifest.status, 'missing');
  await assert.rejects(service.start(), (error) => error.statusCode === 501);
  assert.equal(calls.length, 0);
  assert.equal((await service.snapshot()).task.status, 'idle');
});

test('only fixed responsive mode runs, keeping originals and article bytes unchanged', async (t) => {
  const { root, service, calls, builds } = await fixture(t);
  const image = await imageFixture(root);
  await fs.mkdir(path.join(root, 'content/posts'), { recursive: true });
  const articlePath = path.join(root, 'content/posts/untouched.md');
  const article = '---\ntitle: Article owned by author\n---\n![photo](/assets/img/photo.png)\n';
  await fs.writeFile(articlePath, article);
  await service.start();
  await service.waitForIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], [path.join(root, 'scripts/optimize-images.mjs'), '--responsive']);
  assert.deepEqual(calls[0][2], { cwd: root, timeoutMs: 300_000, maxOutputBytes: 32 * 1024, killSignal: 'SIGKILL' });
  assert.equal(builds(), 1);
  const task = (await service.snapshot()).task;
  assert.equal(task.status, 'success');
  assert.equal(task.code, 0);
  assert.ok(task.startedAt && task.finishedAt);
  assert.equal(await fs.readFile(articlePath, 'utf8'), article);
  assert.deepEqual(await fs.readFile(path.join(root, `static${image.url}`)), image.source);
});

test('simultaneous starts reserve a single task before availability finishes and recover after completion', async (t) => {
  let complete;
  let runs = 0;
  const { service } = await fixture(t, {
    processRunner: { run: () => { runs += 1; return new Promise((resolve) => { complete = resolve; }); } },
  });
  const first = service.start();
  await assert.rejects(service.start(), (error) => error.statusCode === 409);
  assert.equal((await first).task.status, 'running');
  assert.equal(runs, 1);
  complete(successfulResult);
  await service.waitForIdle();
  assert.equal((await service.snapshot()).task.status, 'success');
  await service.start();
  complete({ code: 1, stderr: 'encoder failed' });
  await service.waitForIdle();
  const task = (await service.snapshot()).task;
  assert.equal(task.id, 2);
  assert.equal(task.status, 'error');
  assert.equal(task.code, 1);
  assert.equal(task.output, 'encoder failed');
});

test('timeouts, aborts, thrown errors, and output bounds stay visible without scheduling a build', async (t) => {
  for (const result of [
    { code: 1, timedOut: true, output: 'x'.repeat(500) },
    { code: 1, aborted: true, output: '' },
    new Error('spawn failure'),
  ]) {
    const { service, builds } = await fixture(t, {
      optimizationTimeoutMs: 2500, maxOutputBytes: 32,
      processRunner: { run: async () => { if (result instanceof Error) throw result; return result; } },
    });
    await service.start();
    await service.waitForIdle();
    const task = (await service.snapshot()).task;
    assert.equal(task.status, 'error');
    assert.equal(builds(), 0);
    assert.ok(Buffer.byteLength(task.output) < 100);
    assert.match(task.error, result.timedOut ? /超过 3 秒/ : result.aborted ? /已取消/ : /spawn failure/);
  }
});

test('a synchronous runner failure also releases the task reservation', async (t) => {
  const { service } = await fixture(t, {
    processRunner: { run: () => { throw new Error('synchronous spawn failure'); } },
  });
  await service.start();
  await service.waitForIdle();
  assert.equal((await service.snapshot()).task.status, 'error');
  await service.start();
  await service.waitForIdle();
  assert.equal((await service.snapshot()).task.id, 2);
});

test('preview scheduling failure keeps image success and reports a separate warning that clears next run', async (t) => {
  let builds = 0;
  const { service } = await fixture(t, {
    scheduleBuild: async () => { if (++builds === 1) throw new Error('preview unavailable'); },
  });
  await service.start();
  await service.waitForIdle();
  const first = (await service.snapshot()).task;
  assert.equal(first.status, 'success');
  assert.equal(first.code, 0);
  assert.equal(first.error, '');
  assert.match(first.warning, /图片已生成，但预览构建未能排队：preview unavailable/);
  await service.start();
  await service.waitForIdle();
  const second = (await service.snapshot()).task;
  assert.equal(second.warning, '');
  assert.equal(second.status, 'success');
});

test('manifest statistics count verified candidates and reject stale, missing, malformed, and unsafe entries', async (t) => {
  const { root, service } = await fixture(t);
  const { image, url, candidateUrl } = await imageFixture(root);
  const copy = () => structuredClone(image);
  const stale = { ...copy(), sha256: '0'.repeat(64) };
  const missing = copy(); missing.candidates[0].url = '/assets/img/responsive/missing.webp';
  const wrongSize = copy(); wrongSize.candidates[0].bytes += 1;
  const wrongDimensions = copy(); wrongDimensions.candidates[0].height = 1;
  const unsafe = copy(); unsafe.candidates[0].url = '/assets/img/responsive/../../outside.webp';
  const duplicate = copy(); duplicate.candidates.push({ ...duplicate.candidates[0] });
  for (const name of ['stale', 'missing', 'wrong-size', 'wrong-dimensions', 'unsafe', 'duplicate']) {
    await fs.copyFile(path.join(root, `static${url}`), path.join(root, `static/assets/img/${name}.png`));
  }
  await writeManifest(root, {
    [url]: image,
    '/assets/img/stale.png': stale,
    '/assets/img/missing.png': missing,
    '/assets/img/wrong-size.png': wrongSize,
    '/assets/img/wrong-dimensions.png': wrongDimensions,
    '/assets/img/unsafe.png': unsafe,
    '/assets/img/../outside.png': copy(),
    '/assets/img/duplicate.png': duplicate,
    '/assets/img/non-object.png': null,
  });
  const manifest = (await service.snapshot()).manifest;
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.totalImages, 9);
  assert.equal(manifest.validImages, 2);
  assert.equal(manifest.invalidImages, 7);
  assert.equal(manifest.validCandidates, 2);
  assert.equal(manifest.invalidCandidates, 7);
  assert.equal(manifest.sourceBytes, 2048);
  assert.equal(manifest.candidateBytes, 60);
  assert.equal(candidateUrl, '/assets/img/responsive/photo-480w.webp');
});

test('corrupt manifest JSON is diagnostic and never prevents reading task status', async (t) => {
  const { root, service } = await fixture(t);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/image_variants.json'), '{broken');
  const status = await service.snapshot();
  assert.equal(status.supported, true);
  assert.equal(status.manifest.status, 'invalid');
  assert.equal(status.manifest.validCandidates, 0);
  assert.equal(status.task.status, 'idle');
});

test('a source symlink cannot make an external image count as valid', async (t) => {
  const { root, service } = await fixture(t);
  const { image, url } = await imageFixture(root);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'lilymap-external-image-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const externalImage = path.join(external, 'photo.png');
  await fs.copyFile(path.join(root, `static${url}`), externalImage);
  await fs.rm(path.join(root, `static${url}`));
  try { await fs.symlink(externalImage, path.join(root, `static${url}`), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Creating file symlinks is unavailable on this host.'); return; }
    throw error;
  }
  await writeManifest(root, { [url]: image });
  const status = await service.snapshot();
  assert.equal(status.manifest.validImages, 0);
  assert.equal(status.manifest.invalidImages, 1);
});
