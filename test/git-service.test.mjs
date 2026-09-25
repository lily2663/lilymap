import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createGitService, gitEnvironment, isTransientGitNetworkFailure } from '../src/services/git-service.mjs';

test('gitEnvironment removes inherited one-shot config before adding its own', () => {
  const env = gitEnvironment([['http.version', 'HTTP/1.1']], {
    PATH: 'x',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'malicious.key',
    GIT_CONFIG_VALUE_0: 'bad',
  });
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.version');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'HTTP/1.1');
  assert.equal(env.PATH, 'x');
});

test('transient Git errors are recognized consistently', () => {
  assert.equal(isTransientGitNetworkFailure({ stderr: 'fatal: Could not resolve host: github.com', stdout: '' }), true);
  assert.equal(isTransientGitNetworkFailure({ stderr: 'fatal: authentication failed', stdout: '' }), false);
});

test('git service redacts credentials and exposes normalized status entries', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args.includes('status')) child.stdout.emit('data', Buffer.from(' M content/post.md\n?? new file.md\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = createGitService({ repoRoot: '/tmp/blog', spawnProcess, platform: 'linux', environment: {} });
  assert.deepEqual(await service.gitChanges(), [
    { status: 'M', path: 'content/post.md' },
    { status: '??', path: 'new file.md' },
  ]);
  assert.equal(calls[0].command, 'git');
  assert.equal(calls[0].options.shell, false);

  const token = 'ghp_123456789012345678901234567890';
  const message = service.safeGitFailure({ stderr: `https://oauth2:${token}@github.com/x/y.git authentication failed`, stdout: '' }, token);
  assert.doesNotMatch(message, new RegExp(token));
  assert.match(message, /认证失败/);
});

test('environment proxy is reused for Git network calls without shell interpolation', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const service = createGitService({
    repoRoot: '/tmp/blog',
    spawnProcess,
    platform: 'linux',
    environment: { HTTPS_PROXY: 'http://127.0.0.1:12000' },
  });
  const result = await service.gitNetwork(['fetch', 'github', 'main']);
  assert.equal(result.proxyDetected, true);
  assert.equal(calls[0].options.env.GIT_CONFIG_KEY_0, 'http.proxy');
  assert.equal(calls[0].options.env.GIT_CONFIG_VALUE_0, 'http://127.0.0.1:12000/');
});


test('git service delegates commands to the shared process runner with a timeout', async () => {
  const calls = [];
  const service = createGitService({
    repoRoot: '/tmp/blog',
    platform: 'linux',
    environment: {},
    timeoutMs: 4321,
    processRunner: {
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        return { code: 0, stdout: '', stderr: '', output: '', timedOut: false, aborted: false };
      },
    },
  });

  await service.git(['status', '--short']);
  assert.equal(calls[0].command, 'git');
  assert.equal(calls[0].options.cwd, '/tmp/blog');
  assert.equal(calls[0].options.timeoutMs, 4321);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
});
