import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createBuildService } from '../src/services/build-service.mjs';

function fakeSpawn({ code = 0, stdout = '', stderr = '', error = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (error) child.emit('error', error);
      else child.emit('close', code);
    });
    return child;
  };
}

function controlledRunner() {
  const calls = [];
  return {
    calls,
    runner: {
      run: (command, args, options) => new Promise((resolve) => {
        calls.push({ command, args, options, finish: (result = {}) => resolve({ code: 0, output: '', ...result }) });
      }),
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('build service records successful builds and returns a snapshot', async () => {
  const service = createBuildService({
    repoRoot: '/tmp/blog',
    hugoExecutable: 'hugo',
    spawnProcess: fakeSpawn({ stdout: 'ok\n' }),
  });
  const result = await service.runBuild(true, 'test');
  assert.equal(result.code, 0);
  assert.equal(result.output, 'ok\n');
  assert.equal(result.build.status, 'success');
  assert.equal(result.build.trigger, 'test');
  assert.equal(service.snapshot().status, 'success');
});

test('build service normalizes spawn failures and bounds diagnostic output', async () => {
  const errors = [];
  const service = createBuildService({
    repoRoot: '/tmp/blog',
    hugoExecutable: 'hugo',
    maxOutputBytes: 32,
    onError: (message) => errors.push(message),
    spawnProcess: fakeSpawn({ code: 1, stderr: 'x'.repeat(200) }),
  });
  const result = await service.runBuild();
  assert.equal(result.code, 1);
  assert.equal(result.build.status, 'error');
  assert.match(result.output, /输出已截断/);
  assert.ok(Buffer.byteLength(result.output, 'utf8') < 100);
  assert.equal(errors.length, 1);
});

test('scheduled builds can be cancelled before execution', async () => {
  let spawned = 0;
  const service = createBuildService({
    repoRoot: '/tmp/blog',
    hugoExecutable: 'hugo',
    spawnProcess: (...args) => {
      spawned += 1;
      return fakeSpawn()(...args);
    },
  });
  service.scheduleBuild(50);
  assert.equal(service.snapshot().status, 'queued');
  assert.equal(service.cancelScheduledBuild(), true);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(spawned, 0);
  assert.equal(service.snapshot().status, 'idle');
});


test('build service surfaces process-runner timeouts as bounded build errors', async () => {
  const calls = [];
  const service = createBuildService({
    repoRoot: '/tmp/blog',
    hugoExecutable: 'hugo',
    buildTimeoutMs: 2500,
    processRunner: {
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        return { code: 1, stdout: '', stderr: '', output: '', timedOut: true, aborted: false, error: 'process timed out' };
      },
    },
  });

  const result = await service.runBuild(false, 'timeout-test');
  assert.equal(result.code, 1);
  assert.equal(result.build.status, 'error');
  assert.match(result.output, /超过 3 秒/);
  assert.equal(calls[0].command, 'hugo');
  assert.equal(calls[0].options.timeoutMs, 2500);
});

test('watcher bursts during a running build produce only one follow-up build', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, runner } = controlledRunner();
  const service = createBuildService({ repoRoot: '/tmp/blog', hugoExecutable: 'hugo', processRunner: runner });
  const first = service.runBuild(false, 'manual');

  for (let index = 0; index < 5; index += 1) {
    service.scheduleBuild(20);
    t.mock.timers.tick(20);
  }
  assert.equal(calls.length, 1);
  assert.equal(service.snapshot().status, 'running');
  assert.equal(service.snapshot().trigger, 'manual');
  assert.ok(service.snapshot().queuedAt);

  calls[0].finish();
  assert.equal((await first).build.trigger, 'manual');
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(service.snapshot().trigger, 'scheduled');
  calls[1].finish();
  await settle();
  assert.equal(service.snapshot().status, 'success');
  assert.equal(service.snapshot().queuedAt, null);
  assert.equal(calls.length, 2);
});

test('explicit builds absorb pending automatic work and retain their own options and trigger', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, runner } = controlledRunner();
  const service = createBuildService({ repoRoot: '/tmp/blog', hugoExecutable: 'hugo', processRunner: runner });
  const first = service.runBuild(false, 'preview');
  service.scheduleBuild(20);
  t.mock.timers.tick(20);
  const second = service.runBuild(true, 'manual');
  assert.equal(service.snapshot().trigger, 'preview');
  assert.equal(calls.length, 1);

  calls[0].finish();
  const firstResult = await first;
  assert.equal(firstResult.build.trigger, 'preview');
  assert.equal(firstResult.build.status, 'success');
  assert.equal(calls.length, 2);
  assert.equal(service.snapshot().trigger, 'manual');
  assert.ok(calls[1].args.includes('--minify'));
  calls[1].finish();
  assert.equal((await second).build.trigger, 'manual');
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(service.snapshot().status, 'success');
});

test('automatic work can still be cancelled after its debounce expires during a build', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, runner } = controlledRunner();
  const service = createBuildService({ repoRoot: '/tmp/blog', hugoExecutable: 'hugo', processRunner: runner });
  const first = service.runBuild();
  service.scheduleBuild(20);
  t.mock.timers.tick(20);
  assert.equal(service.cancelScheduledBuild(), true);
  assert.equal(service.cancelScheduledBuild(), false);
  assert.equal(service.snapshot().queuedAt, null);
  calls[0].finish();
  await first;
  await settle();
  assert.equal(calls.length, 1);
});

test('changes made during the automatic follow-up are rebuilt afterward', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, runner } = controlledRunner();
  const service = createBuildService({ repoRoot: '/tmp/blog', hugoExecutable: 'hugo', processRunner: runner });
  const first = service.runBuild();
  service.scheduleBuild(20);
  t.mock.timers.tick(20);
  calls[0].finish();
  await first;
  assert.equal(calls.length, 2);

  service.scheduleBuild(20);
  t.mock.timers.tick(20);
  calls[1].finish();
  await settle();
  assert.equal(calls.length, 3);
  calls[2].finish();
  await settle();
  assert.equal(service.snapshot().status, 'success');
});

test('failed builds and diagnostic callback errors do not strand queued requests', async () => {
  const { calls, runner } = controlledRunner();
  const service = createBuildService({
    repoRoot: '/tmp/blog', hugoExecutable: 'hugo', processRunner: runner,
    onError: () => { throw new Error('logger unavailable'); },
  });
  const first = service.runBuild(false, 'first');
  const second = service.runBuild(false, 'second');
  calls[0].finish({ code: 1, output: 'invalid template' });
  const result = await first;
  assert.equal(result.build.status, 'error');
  assert.equal(result.output, 'invalid template');
  assert.equal(calls.length, 2);
  calls[1].finish();
  assert.equal((await second).build.status, 'success');
});

test('scheduled work masks stale diagnostics and cancellation restores the last result', async () => {
  const service = createBuildService({
    repoRoot: '/tmp/blog', hugoExecutable: 'hugo', onError: () => {},
    processRunner: { run: async () => ({ code: 1, output: 'invalid template' }) },
  });
  await service.runBuild();
  const previous = service.snapshot();
  service.scheduleBuild(50);
  const queued = service.snapshot();
  assert.equal(queued.status, 'queued');
  assert.equal(queued.code, null);
  assert.equal(queued.output, '');
  assert.equal(queued.finishedAt, null);
  service.cancelScheduledBuild();
  assert.deepEqual(service.snapshot(), previous);
});

test('missing configured Hugo paths return an actionable installation message', async () => {
  const service = createBuildService({
    repoRoot: '/tmp/blog', hugoExecutable: 'C:\\tools\\hugo.exe', onError: () => {},
    processRunner: { run: async () => ({ code: 1, error: 'spawn C:\\tools\\hugo.exe ENOENT' }) },
  });
  assert.match((await service.runBuild()).output, /未找到 Hugo.*hugoPath/);
});

test('diagnostic tails stay bounded in bytes without breaking UTF-8 characters', async () => {
  const service = createBuildService({
    repoRoot: '/tmp/blog', hugoExecutable: 'hugo', maxOutputBytes: 32, onError: () => {},
    processRunner: { run: async () => ({ code: 1, output: '构建日志'.repeat(50) }) },
  });
  const { output } = await service.runBuild();
  const prefix = '…（输出已截断）\n';
  assert.ok(output.startsWith(prefix));
  assert.ok(Buffer.byteLength(output.slice(prefix.length), 'utf8') <= 32);
  assert.ok(output.endsWith('日志'));
  assert.ok(!output.includes('\ufffd'));
  assert.equal(service.snapshot().output, output);
});
