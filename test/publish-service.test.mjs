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
