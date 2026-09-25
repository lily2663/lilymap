import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveInside } from '../src/fs/path-security.mjs';

test('resolveInside rejects lexical traversal and symlink escapes', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-path-'));
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'safe'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  assert.equal(resolveInside(root, '../outside/secret.txt'), null);
  assert.equal(resolveInside(root, 'safe/new.txt'), path.join(root, 'safe', 'new.txt'));

  const link = path.join(root, 'escape');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveInside(root, 'escape/secret.txt'), null);
});

test('resolveInside allows symlinks that remain inside the managed root', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-path-'));
  const root = path.join(base, 'repo');
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const link = path.join(root, 'inside-link');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveInside(root, 'inside-link/file.txt'), path.join(root, 'inside-link', 'file.txt'));
});
