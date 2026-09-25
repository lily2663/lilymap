import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { createAtomicFileService } from '../src/fs/atomic-files.mjs';
import { createFileTransactionService } from '../src/fs/file-transaction.mjs';
import { createSiteSettingsService } from '../src/services/site-settings-service.mjs';
import { parseToml } from '../src/domain/toml.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const themeRoot = path.join(root, 'themes', 'demo');
  const siteDataFile = path.join(root, 'data', 'site.yaml');
  await fsp.mkdir(path.dirname(siteDataFile), { recursive: true });
  await fsp.mkdir(themeRoot, { recursive: true });
  await fsp.writeFile(siteDataFile, YAML.stringify({
    author: 'Before',
    avatar: '/old.png',
    aboutTitle: 'About',
    about: ['hello'],
    links: [],
    friends: [],
  }));
  await fsp.writeFile(path.join(root, 'hugo.toml'), '[params]\nauthor = "Before"\navatar = "/old.png"\nmode = 1\n');
  await fsp.writeFile(path.join(themeRoot, 'theme-config.schema.json'), JSON.stringify({
    sections: [{
      id: 'main',
      fields: [
        { path: 'params.author', type: 'string' },
        { path: 'params.avatar', type: 'url' },
        { path: 'params.mode', type: 'select', options: [{ value: 1 }, { value: 2 }] },
      ],
    }],
  }));

  let builds = 0;
  const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const atomic = createAtomicFileService({
    scheduleBuild: () => { builds += 1; },
    httpError,
  });
  const transaction = createFileTransactionService({
    stageFile: atomic.stageFile,
    atomicWrite: atomic.atomicWrite,
    scheduleBuild: () => { builds += 1; },
  });
  const service = createSiteSettingsService({
    repoRoot: root,
    siteDataFile,
    themeRoot,
    fileTransaction: transaction,
    atomicWrite: atomic.atomicWrite,
    httpError,
    maxBodyBytes: 1024 * 1024,
  });
  return { root, themeRoot, siteDataFile, service, builds: () => builds };
}

test('profile updates keep site YAML and hugo.toml author in one transaction', async (t) => {
  const { root, siteDataFile, service, builds } = await fixture(t);
  const current = await service.readProfile();
  const result = await service.updateProfile({
    version: current.version,
    profile: {
      author: 'After',
      aboutTitle: 'About',
      about: ['updated'],
      links: [],
    },
  });

  assert.equal(result.profile.author, 'After');
  assert.equal(YAML.parse(await fsp.readFile(siteDataFile, 'utf8')).author, 'After');
  assert.equal(parseToml(await fsp.readFile(path.join(root, 'hugo.toml'), 'utf8')).values['params.author'], 'After');
  assert.equal(builds(), 1);
});

test('profile update rejects stale versions before mutating files', async (t) => {
  const { root, siteDataFile, service, builds } = await fixture(t);
  const beforeSite = await fsp.readFile(siteDataFile, 'utf8');
  const beforeToml = await fsp.readFile(path.join(root, 'hugo.toml'), 'utf8');

  await assert.rejects(
    service.updateProfile({
      version: 'stale',
      profile: { author: 'Nope', aboutTitle: '', about: [], links: [] },
    }),
    (error) => error.statusCode === 409,
  );

  assert.equal(await fsp.readFile(siteDataFile, 'utf8'), beforeSite);
  assert.equal(await fsp.readFile(path.join(root, 'hugo.toml'), 'utf8'), beforeToml);
  assert.equal(builds(), 0);
});

test('settings patch preserves typed select values and synchronizes identity data', async (t) => {
  const { root, siteDataFile, service, builds } = await fixture(t);
  const result = await service.patchSettings({
    values: {
      'params.author': 'Lily',
      'params.avatar': '/new.png',
      'params.mode': 2,
    },
  });

  const toml = parseToml(await fsp.readFile(path.join(root, 'hugo.toml'), 'utf8'));
  const site = YAML.parse(await fsp.readFile(siteDataFile, 'utf8'));
  assert.equal(toml.values['params.author'], 'Lily');
  assert.equal(toml.values['params.avatar'], '/new.png');
  assert.equal(toml.values['params.mode'], 2);
  assert.equal(site.author, 'Lily');
  assert.equal(site.avatar, '/new.png');
  assert.equal(result.values['params.mode'], 2);
  assert.equal(builds(), 1);
});
