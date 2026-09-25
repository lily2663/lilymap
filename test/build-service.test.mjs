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
