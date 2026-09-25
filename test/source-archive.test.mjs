import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { createLilyMapSourceArchive } from '../src/services/source-archive.mjs';

function tarEntries(buffer) {
  const names = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const rawSize = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(rawSize || '0', 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

test('source archive discovers controlled roots without a hand-maintained file list', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-archive-'));
  const source = path.join(root, 'tools', 'admin');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = {
    'server.mjs': 'export {};',
    'package.json': '{}',
    'public/index.html': '<main></main>',
    'public/js/new-feature.js': 'export const ok = true;',
    'src/domain/value.mjs': 'export {};',
    'src/services/new-service.mjs': 'export {};',
    'test/new-service.test.mjs': 'export {};',
    'node_modules/ignored/index.js': 'do not export',
  };
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(source, ...name.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, value);
  }

  const archive = await createLilyMapSourceArchive({ repoRoot: root, adminDir: source });
  const names = tarEntries(gunzipSync(archive));
  assert.ok(names.includes('tools/admin/server.mjs'));
  assert.ok(names.includes('tools/admin/public/js/new-feature.js'));
  assert.ok(names.includes('tools/admin/src/services/new-service.mjs'));
  assert.ok(names.includes('tools/admin/test/new-service.test.mjs'));
  assert.ok(!names.some((name) => name.includes('node_modules')));
});
