import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAtomicFileService } from '../src/fs/atomic-files.mjs';
import { createFileTransactionService } from '../src/fs/file-transaction.mjs';
import { createLayoutModuleService } from '../src/services/layout-module-service.mjs';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function baseFixture(t, fsApi = fsp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-layouts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builtInLayoutsRoot = path.join(root, 'theme', 'data', 'lily', 'layouts');
  const userLayoutsRoot = path.join(root, 'data', 'lily', 'layouts');
  const builtInModulesRoot = path.join(root, 'theme', 'data', 'lily', 'modules');
  const userModulesRoot = path.join(root, 'data', 'lily', 'modules');
  const trashRoot = path.join(root, '.admin-trash');
  for (const dir of [builtInLayoutsRoot, userLayoutsRoot, builtInModulesRoot, userModulesRoot]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.writeFile(path.join(root, 'hugo.toml'), '[params]\n');

  let builds = 0;
  const atomic = createAtomicFileService({
    scheduleBuild: () => { builds += 1; },
    httpError,
  });
  const transaction = createFileTransactionService({
    stageFile: atomic.stageFile,
    atomicWrite: atomic.atomicWrite,
    scheduleBuild: () => { builds += 1; },
  });

  const service = createLayoutModuleService({
    repoRoot: root,
    builtInLayoutsRoot,
    userLayoutsRoot,
    builtInModulesRoot,
    userModulesRoot,
    trashRoot,
    maxBodyBytes: 1024 * 1024,
    fileTransaction: transaction,
    atomicWrite: atomic.atomicWrite,
    scheduleBuild: () => { builds += 1; },
    fsApi,
    now: () => new Date('2026-09-25T12:34:56.000Z'),
  });
  return {
    root, builtInLayoutsRoot, userLayoutsRoot, builtInModulesRoot, userModulesRoot,
    trashRoot, service, builds: () => builds,
  };
}

test('layout service snapshots an existing override before saving a new revision', async (t) => {
  const { userLayoutsRoot, builtInModulesRoot, service } = await baseFixture(t);
  await fsp.writeFile(path.join(builtInModulesRoot, 'quote.yaml'), [
    'id: quote',
    'allowedSlots:',
    '  - home.main',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(userLayoutsRoot, 'home.yaml'), [
    'kind: home',
    'slots:',
    '  main:',
    '    - id: old',
    '      module: quote',
    '',
  ].join('\n'));

  const result = await service.saveLayout({
    name: 'home',
    raw: [
      'kind: home',
      'slots:',
      '  main:',
      '    - id: next',
      '      module: quote',
      '',
    ].join('\n'),
  });

  assert.match(result.backup, /^\.admin-trash\/layouts\/home\/2026-09-25T12-34-56-000Z\.yaml$/);
  assert.match(await fsp.readFile(path.join(userLayoutsRoot, 'home.yaml'), 'utf8'), /id: next/);
  const history = await service.layoutHistory('home');
  assert.equal(history.length, 1);
});

test('module uninstall rolls already moved files back when a later rename fails', async (t) => {
  let renameCount = 0;
  const fsApi = new Proxy(fsp, {
    get(target, key) {
      const value = target[key];
      if (key !== 'rename') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args) => {
        renameCount += 1;
        if (renameCount === 2) throw Object.assign(new Error('injected move failure'), { code: 'EIO' });
        return fsp.rename(...args);
      };
    },
  });

  const fixture = await baseFixture(t, fsApi);
  const manifestPath = path.join(fixture.userModulesRoot, 'demo.yaml');
  const templatePath = path.join(fixture.root, 'layouts', 'partials', 'lily', 'modules', 'demo', 'render.html');
  await fsp.mkdir(path.dirname(templatePath), { recursive: true });
  await fsp.writeFile(manifestPath, [
    'id: demo',
    'allowedSlots:',
    '  - home.main',
    'template:',
    '  partial: lily/modules/demo/render.html',
    '',
  ].join('\n'));
  await fsp.writeFile(templatePath, '<section>demo</section>');

  await assert.rejects(() => fixture.service.uninstallSiteModule('demo'), /injected move failure/);
  assert.equal(await fsp.readFile(manifestPath, 'utf8').then(() => true).catch(() => false), true);
  assert.equal(await fsp.readFile(templatePath, 'utf8').then(() => true).catch(() => false), true);
  assert.equal(fixture.builds(), 0);
});

test('built-in modules cannot be overwritten through the installer', async (t) => {
  const { builtInModulesRoot, service } = await baseFixture(t);
  await fsp.writeFile(path.join(builtInModulesRoot, 'quote.yaml'), [
    'id: quote',
    'allowedSlots:',
    '  - home.main',
    '',
  ].join('\n'));

  await assert.rejects(
    () => service.installSiteModule({
      manifest: 'id: quote\nallowedSlots:\n  - home.main\n',
      template: '<div></div>',
    }),
    /不能覆盖内置模块/,
  );
});
