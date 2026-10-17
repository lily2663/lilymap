import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createAtomicFileService } from '../src/fs/atomic-files.mjs';
import { createFileTransactionService } from '../src/fs/file-transaction.mjs';
import { createSiteSettingsService } from '../src/services/site-settings-service.mjs';
import { createLayoutModuleService } from '../src/services/layout-module-service.mjs';

const theme = process.env.LILY_TEST_THEME_PATH;
const hugo = process.env.LILY_TEST_HUGO_PATH;
// Synthetic 64 px square; no personal assets or project files enter the fixture.
const avatar = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAl0lEQVR4nO3QMREAIBDAsJeNHGZMgowMdMje66yz789GB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoD3c+BKVzr9W2QAAAABJRU5ErkJggg==", "base64");

test('LilyMap settings and module saves preserve theme pagination, icons and weather contracts', { skip: !theme || !hugo }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lilymap-theme-settings-'));
  const put = async (name, value) => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  try {
    await put('hugo.toml', 'baseURL="https://fixture.invalid/"\ntitle="Fixture"\ndisableKinds=["taxonomy", "term", "RSS", "sitemap"]\n[params]\ncustomSetting="preserve"\n');
    await put('data/site.yaml', 'author: Fixture\n');
    await put('static/assets/avatar.png', avatar);
    await put('static/assets/custom.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48"/></svg>');
    for (let index = 1; index <= 4; index += 1) {
      await put(`content/posts/post-${index}.md`, `---\ntitle: Post ${index}\ndate: 2020-01-0${index}\n---\nFixture body ${index}.\n`);
    }

    let scheduled = 0;
    const scheduleBuild = () => { scheduled += 1; };
    const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
    const atomic = createAtomicFileService({ scheduleBuild, httpError });
    const fileTransaction = createFileTransactionService({ ...atomic, scheduleBuild });
    const settings = createSiteSettingsService({
      repoRoot: root, siteDataFile: path.join(root, 'data/site.yaml'), themeRoot: theme,
      fileTransaction, atomicWrite: atomic.atomicWrite, httpError, maxBodyBytes: 1024 * 1024,
    });
    const modules = createLayoutModuleService({
      repoRoot: root,
      builtInLayoutsRoot: path.join(theme, 'data/lily/layouts'),
      builtInModulesRoot: path.join(theme, 'data/lily/modules'),
      userLayoutsRoot: path.join(root, 'data/lily/layouts'),
      userModulesRoot: path.join(root, 'data/lily/modules'),
      trashRoot: path.join(root, '.admin-trash'), maxBodyBytes: 1024 * 1024,
      fileTransaction, atomicWrite: atomic.atomicWrite, scheduleBuild,
    });
    await settings.patchSettings({ values: {
      'params.avatar': '/assets/avatar.png', 'params.favicon': '',
      'params.description': 'Fixture description', 'params.features.prefetch': false,
      'params.mobileHub.defaultModule': 'weather', 'params.mobileHub.rememberTab': true,
    } });
    await modules.saveLayout({ name: 'home', parsed: {
      kind: 'home', slotOrder: ['hero', 'main', 'sidebar'], slots: { hero: [], main: [], sidebar: [] },
    } });
    await modules.configureModule({
      layout: 'home', slot: 'main', module: 'recent-posts', enabled: true,
      config: { title: 'Managed posts', pageSize: 2, limit: 3, sort: 'title' },
    });
    await modules.configureModule({
      layout: 'home', slot: 'sidebar', module: 'weather', enabled: true,
      config: { title: 'Managed weather', latitude: 0, longitude: 12.5, unit: 'fahrenheit' },
    });
    const saved = await settings.readSettings();
    assert.equal(saved.values['params.customSetting'], 'preserve');
    assert.equal(saved.values['params.favicon'], '');
    assert.equal(scheduled, 4, 'each management action schedules a build once');

    const build = (destination) => {
      const result = spawnSync(hugo, [
        '--source', root, '--themesDir', path.dirname(theme), '--theme', path.basename(theme),
        '--destination', destination, '--cacheDir', path.join(root, 'cache'), '--noBuildLock', '--panicOnWarning',
      ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HUGO_BUILD_NOJSCONFIGINASSETS: 'true' } });
      assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    };
    const output = path.join(root, 'generated-icon');
    build(output);
    const home = await readFile(path.join(output, 'index.html'), 'utf8');
    const second = await readFile(path.join(output, 'page/2/index.html'), 'utf8');
    assert.match(home, /data-post-total="3"/);
    assert.equal((home.match(/class="post-item"/g) || []).length, 2, 'manager page size controls the real paginator');
    assert.equal((second.match(/class="post-item"/g) || []).length, 1, 'manager total limit is applied before pagination');
    assert.match(second, /<title>Fixture · 第 2 页<\/title>/);
    assert.match(second, /<link rel="canonical" href="https:\/\/fixture\.invalid\/page\/2\/">/);
    assert.match(second, /<meta property="og:url" content="https:\/\/fixture\.invalid\/page\/2\/">/);
    const structured = JSON.parse(second.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]);
    assert.equal(structured.url, 'https://fixture.invalid/page/2/');
    assert.match(home, /data-latitude="0" data-longitude="12.5" data-unit="fahrenheit"/);
    assert.match(home, /Managed weather/);
    assert.match(home, /data-prefetch="false"/);
    assert.match(home, /data-mobile-hub-default="weather" data-mobile-hub-remember="true"/);
    const icon = home.match(/<link rel="icon" href="([^"]+)" type="image\/png" sizes="48x48">/);
    assert.ok(icon, 'blank favicon uses the generated 48 px local avatar icon');
    const image = await readFile(path.join(output, icon[1].replace(/^\//, '')));
    assert.equal(image.readUInt32BE(16), 48);
    assert.equal(image.readUInt32BE(20), 48);
    assert.deepEqual(await readFile(path.join(root, 'static/assets/avatar.png')), avatar);

    await settings.patchSettings({ values: { 'params.favicon': '/assets/custom.svg?v=2' } });
    const explicitOutput = path.join(root, 'explicit-icon');
    build(explicitOutput);
    const explicit = await readFile(path.join(explicitOutput, 'index.html'), 'utf8');
    assert.match(explicit, /<link rel="icon" href="\/assets\/custom\.svg\?v=2">/);
    assert.equal((await settings.readSettings()).values['params.customSetting'], 'preserve');
  } finally {
    assert.ok(path.basename(root).startsWith('lilymap-theme-settings-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
