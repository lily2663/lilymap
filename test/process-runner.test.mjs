import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createProcessRunner } from '../src/services/process-runner.mjs';

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

test('process runner forces shell=false and captures bounded output', async () => {
  let options;
  const runner = createProcessRunner({
    defaultTimeoutMs: 0,
    spawnProcess: (command, args, received) => {
      options = received;
      const child = childProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('x'.repeat(80)));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await runner.run('tool', ['--version'], { maxOutputBytes: 32 });
  assert.equal(result.code, 0);
  assert.equal(options.shell, false);
  assert.match(result.stdout, /输出已截断/);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') < 100);
});

test('process runner terminates hung children at the timeout boundary', async () => {
  let child;
  const runner = createProcessRunner({
    defaultTimeoutMs: 10,
    spawnProcess: () => (child = childProcess()),
  });

  const result = await runner.run('hung');
  assert.equal(result.code, 1);
  assert.equal(result.timedOut, true);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.match(result.error, /timed out/);
});

test('process runner honors AbortSignal without invoking a shell', async () => {
  let child;
  const controller = new AbortController();
  const runner = createProcessRunner({
    defaultTimeoutMs: 0,
    spawnProcess: () => (child = childProcess()),
  });

  const pending = runner.run('long-task', [], { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.deepEqual(child.kills, ['SIGTERM']);
});
