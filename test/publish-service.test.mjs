import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPublishService, validBlogRemote, validPublishBranch } from '../src/services/publish-service.mjs';

test('publish target validators reject unsafe remotes and branch refs', () => {
  assert.equal(validBlogRemote('https://github.com/lily/site.git'), true);
  assert.equal(validBlogRemote('http://github.com/lily/site.git'), false);
  assert.equal(validBlogRemote('https://evil.example/lily/site.git'), false);
  assert.equal(validPublishBranch('main'), true);
  assert.equal(validPublishBranch('release/v1'), true);
  for (const value of ['', '../main', 'a..b', 'feature//x', 'main.lock', 'x/']) assert.equal(validPublishBranch(value), false);
});

test('publish service persists local target and token without exposing them through Git args', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let remote = '';
  const git = async (args) => {
    calls.push(args);
    if (args[0] === 'remote' && args[1] === 'get-url') return remote ? { code: 0, stdout: remote, stderr: '' } : { code: 2, stdout: '', stderr: '' };
    if (args[0] === 'remote' && args[1] === 'add') { remote = args[3]; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'remote' && args[1] === 'set-url') { remote = args[3]; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'remote' && args[1] === 'remove') { remote = ''; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const atomicWrite = async (target, content) => {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  };
  const service = createPublishService({
    repoRoot: root,
    trashRoot: path.join(root, '.admin-trash'),
    exists: async (target) => fsp.access(target).then(() => true).catch(() => false),
    atomicWrite,
    git,
    gitNetwork: git,
    safeGitFailure: () => 'git failed',
  });

  assert.deepEqual(await service.setTarget('https://github.com/lily/site.git', 'main'), {
    remote: 'https://github.com/lily/site.git',
    branch: 'main',
  });
  assert.equal(await service.remote(), 'https://github.com/lily/site.git');
  assert.equal(await service.branch(), 'main');

  const token = 'ghp_123456789012345678901234567890';
  assert.deepEqual(await service.saveToken(token), { tokenPresent: true });
  assert.equal((await fsp.readFile(path.join(root, '.token'), 'utf8')).trim(), token);
  assert.equal(await service.tokenPresent(), true);
  assert.ok(calls.every((args) => !args.join(' ').includes(token)));
});


async function publishFixture(t, {
  pushResult = { code: 0, stdout: '', stderr: '' },
  remoteAfterPush,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-publish-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const remote = 'https://github.com/lily/site.git';
  const branch = 'main';
  const oldSha = '1'.repeat(40);
  const localSha = '2'.repeat(40);
  const token = 'ghp_123456789012345678901234567890';
  await fsp.writeFile(path.join(root, '.token'), token);
  await fsp.writeFile(path.join(root, '.lilymap-local.json'), JSON.stringify({ publishRemote: remote, publishBranch: branch }));

  const gitCalls = [];
  const networkCalls = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

  const git = async (args) => {
    gitCalls.push(args);
    const key = args.join(' ');
    if (key === 'remote get-url github') return ok(remote + '\n');
    if (key.startsWith('ls-files -- ')) return ok('');
    if (key.startsWith('add -A -- .')) return ok('');
    if (key === 'diff --cached --name-only --') return ok('');
    if (key === 'diff --cached --quiet') return ok('');
    if (key === 'rev-parse FETCH_HEAD') return ok(oldSha + '\n');
    if (key === 'rev-list --count FETCH_HEAD --not HEAD') return ok('0\n');
    if (key === 'rev-parse HEAD') return ok(localSha + '\n');
    throw new Error(`unexpected git call: ${key}`);
  };

  const gitNetwork = async (args) => {
    networkCalls.push(args);
    const key = args.join(' ');
    if (key === 'fetch github main') return ok('');
    if (args[0] === 'push') return pushResult;
    if (key === 'ls-remote github refs/heads/main') {
      const sha = remoteAfterPush ?? localSha;
      return ok(sha ? `${sha}\trefs/heads/main\n` : '');
    }
    throw new Error(`unexpected network git call: ${key}`);
  };

  const service = createPublishService({
    repoRoot: root,
    trashRoot: path.join(root, '.admin-trash'),
    exists: async (target) => fsp.access(target).then(() => true).catch(() => false),
    atomicWrite: async (target, content) => fsp.writeFile(target, content),
    git,
    gitNetwork,
    safeGitFailure: () => 'sanitized failure',
  });

  return { service, gitCalls, networkCalls, localSha, oldSha, token };
}

test('publish reconciles an ambiguous push failure when remote already equals local HEAD', async (t) => {
  const fixture = await publishFixture(t, {
    pushResult: { code: 1, stdout: '', stderr: 'connection reset after send-pack' },
  });

  const result = await fixture.service.publishToBlog('', false);
  assert.equal(result.reconciledAfterAmbiguousFailure, true);
  assert.match(result.message, /main/);
  assert.ok(fixture.networkCalls.some((args) => args[0] === 'ls-remote'));
  assert.ok(fixture.networkCalls.every((args) => !args.join(' ').includes(fixture.token)));
});

test('publish keeps a failed result when remote does not match local HEAD after push error', async (t) => {
  const fixture = await publishFixture(t, {
    pushResult: { code: 1, stdout: '', stderr: 'connection reset' },
    remoteAfterPush: '3'.repeat(40),
  });

  await assert.rejects(
    () => fixture.service.publishToBlog('', false),
    /push 失败：sanitized failure/,
  );
});
