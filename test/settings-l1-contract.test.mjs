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
import { analyzeToml, parseToml, patchMenus, patchTomlValue, validateToml } from '../src/domain/toml.mjs';

// 这一组用例覆盖执行说明书 03.7 表格里与 LM-02/LM-03 相关的行。
// 全部使用临时 fixture，不读取也不写入真实博客仓库的 hugo.toml 或 data/site.yaml。

const SCHEMA = {
  sections: [{
    id: 'main',
    fields: [
      { path: 'params.author', type: 'string' },
      { path: 'params.avatar', type: 'url' },
      { path: 'params.description', type: 'string' },
      { path: 'params.accent', type: 'color' },
      { path: 'params.webFonts', type: 'boolean' },
      { path: 'params.mode', type: 'select', options: [{ value: 1 }, { value: 2 }] },
      { path: 'params.particles', type: 'number' },
    ],
  }],
};

const TOML_FIXTURE = [
  '# 顶层注释不应被移除',
  'baseURL = "https://fixture.invalid/"',
  'title = "Fixture"',
  '',
  '[params]',
  '  author = "Before"           # 作者行内注释',
  '  avatar = "/old.png"',
  '  description = "旧简介"',
  '  accent = "#7fb5b0"',
  '  webFonts = false',
  '  mode = 1',
  '  particles = 30',
  '  # 未知的 Hugo/自定义键必须原样保留',
  '  customSetting = "preserve"',
  '  complexUnknown = { deep = [1, 2], label = "x" }',
  '  multilineNote = """第一行',
  '第二行"""',
  '',
  '[params.unknownNested]',
  '  arr = [[1, 2], [3, 4]]',
  '  flag = true',
  '',
  '[[menus.main]]',
  '  name = "首页"',
  '  url = "/"',
  '  weight = 10',
  '  identifier = "home"',
  '',
  '[[menus.main]]',
  '  name = "关于"',
  '  url = "/about/"',
  '  weight = 20',
  '',
  '[otherSync]',
  '  key = "v"',
  '',
].join('\r\n');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-l1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const themeRoot = path.join(root, 'themes', 'demo');
  const siteDataFile = path.join(root, 'data', 'site.yaml');
  const tomlPath = path.join(root, 'hugo.toml');
  await fsp.mkdir(path.dirname(siteDataFile), { recursive: true });
  await fsp.mkdir(themeRoot, { recursive: true });
  await fsp.writeFile(siteDataFile, YAML.stringify({
    author: 'Before', avatar: '/old.png', aboutTitle: 'About', about: ['hello'], links: [], friends: [],
  }));
  await fsp.writeFile(tomlPath, TOML_FIXTURE);
  await fsp.writeFile(path.join(themeRoot, 'theme-config.schema.json'), JSON.stringify(SCHEMA));

  let builds = 0;
  const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const atomic = createAtomicFileService({ scheduleBuild: () => { builds += 1; }, httpError });
  const fileTransaction = createFileTransactionService({
    stageFile: atomic.stageFile, atomicWrite: atomic.atomicWrite,
    scheduleBuild: () => { builds += 1; },
  });
  const service = createSiteSettingsService({
    repoRoot: root, siteDataFile, themeRoot, fileTransaction,
    atomicWrite: atomic.atomicWrite, httpError, maxBodyBytes: 1024 * 1024,
  });
  return { root, tomlPath, siteDataFile, themeRoot, service, builds: () => builds };
}

async function state(service) {
  const data = await service.readSettings();
  return {
    baseVersion: data.versions.settings,
    schemaVersion: data.versions.schema,
    identityVersion: data.versions.identity,
  };
}

const readToml = (file) => fsp.readFile(file, 'utf8');
const mtime = async (file) => (await fsp.stat(file)).mtimeMs;

test('GET /api/settings returns versions, capabilities and per-field edit modes', async (t) => {
  const { service } = await fixture(t);
  const data = await service.readSettings();
  assert.equal(typeof data.versions.settings, 'string');
  assert.equal(typeof data.versions.schema, 'string');
  assert.equal(typeof data.versions.identity, 'string');
  assert.equal(data.versions.settings.length, 64, 'settings version is a sha256 hex digest');
  assert.equal(data.capabilities.settingsOptimisticLock, true);
  assert.equal(data.capabilities.settingsDiff, true);
  assert.equal(data.capabilities.settingsTomlValidation, true);
  assert.equal(data.valid, true);
  // 未知键被保留在 values 里，且不阻止读取
  assert.equal(data.values['params.customSetting'], 'preserve');
  assert.equal(data.fieldModes['params.description'].editable, true);
  // 多行值字段不可可视化编辑
  assert.equal(data.fieldModes['params.multilineNote'], undefined, 'multilineNote is not declared in schema');
  assert.equal(data.menus.length, 2);
  assert.equal(data.menusMode.editable, true);
});

test('unchanged save is changed:false and leaves bytes and mtime untouched', async (t) => {
  const { service, tomlPath, builds } = await fixture(t);
  const versions = await state(service);
  const before = await readToml(tomlPath);
  const beforeMtime = await mtime(tomlPath);

  const result = await service.patchSettings({ ...versions, values: {} });

  assert.equal(result.changed, false);
  assert.deepEqual(result.appliedFields, []);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(await readToml(tomlPath), before);
  assert.equal(await mtime(tomlPath), beforeMtime);
  assert.equal(builds(), 0, 'changed:false must not trigger a rebuild');
});

test('resubmitting the current values is still changed:false', async (t) => {
  const { service, tomlPath, builds } = await fixture(t);
  const versions = await state(service);
  const current = await service.readSettings();
  const before = await readToml(tomlPath);

  const result = await service.patchSettings({
    ...versions,
    values: { 'params.description': current.values['params.description'] },
  });

  assert.equal(result.changed, false);
  assert.equal(await readToml(tomlPath), before);
  assert.equal(builds(), 0);
});

test('changing one key only rewrites that key and preserves everything else', async (t) => {
  const { service, tomlPath, builds } = await fixture(t);
  const versions = await state(service);
  const before = await readToml(tomlPath);

  const result = await service.patchSettings({ ...versions, values: { 'params.description': '新简介' } });

  const after = await readToml(tomlPath);
  assert.equal(result.changed, true);
  assert.deepEqual(result.appliedFields, ['params.description']);
  assert.equal(parseToml(after).values['params.description'], '新简介');
  // 只有一行不同
  const diff = before.split('\r\n').map((line, index) => (line === after.split('\r\n')[index] ? null : index)).filter((index) => index !== null);
  assert.equal(diff.length, 1, `expected exactly one changed line, got ${JSON.stringify(diff)}`);
  // 未知表 / 数组 / 内联表 / 多行文本 / 菜单 / 注释全部原样
  for (const fragment of [
    '# 顶层注释不应被移除',
    '# 作者行内注释',
    '  customSetting = "preserve"',
    '  complexUnknown = { deep = [1, 2], label = "x" }',
    '  multilineNote = """第一行',
    '[params.unknownNested]',
    '  arr = [[1, 2], [3, 4]]',
    '  identifier = "home"',
    '[otherSync]',
  ]) {
    assert.ok(after.includes(fragment), `lost fragment: ${fragment}`);
  }
  assert.ok(after.includes('\r\n'), 'CRLF preserved');
  assert.equal(after.charCodeAt(0) === 0xfeff, false);
  assert.equal(builds(), 1, 'a real change schedules exactly one rebuild');
});

test('false, 0 and empty string stay distinct from missing keys', async (t) => {
  const { service, tomlPath } = await fixture(t);
  let versions = await state(service);

  // false 是显式值，不能被当作“未设置”
  let result = await service.patchSettings({ ...versions, values: { 'params.webFonts': true } });
  assert.equal(parseToml(await readToml(tomlPath)).values['params.webFonts'], true);
  versions = await state(service);
  result = await service.patchSettings({ ...versions, values: { 'params.webFonts': false } });
  assert.equal(result.changed, true);
  assert.equal(parseToml(await readToml(tomlPath)).values['params.webFonts'], false);

  // 0 是有效数字
  versions = await state(service);
  await service.patchSettings({ ...versions, values: { 'params.particles': 0 } });
  assert.equal(parseToml(await readToml(tomlPath)).values['params.particles'], 0);

  // 空字符串是显式值
  versions = await state(service);
  await service.patchSettings({ ...versions, values: { 'params.description': '' } });
  assert.equal(parseToml(await readToml(tomlPath)).values['params.description'], '');
});

test('older client without versions gets 428 and no file is touched', async (t) => {
  const { service, tomlPath, builds } = await fixture(t);
  const before = await readToml(tomlPath);
  const beforeMtime = await mtime(tomlPath);

  await assert.rejects(
    service.patchSettings({ values: { 'params.description': '无版本' } }),
    (error) => error.statusCode === 428 && error.code === 'SETTINGS_VERSION_REQUIRED',
  );
  assert.equal(await readToml(tomlPath), before);
  assert.equal(await mtime(tomlPath), beforeMtime);
  assert.equal(builds(), 0);
});

test('raw save without versions also gets 428', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const before = await readToml(tomlPath);
  await assert.rejects(
    service.replaceSettingsRaw({ raw: before.replace('Before', 'Hacked') }),
    (error) => error.statusCode === 428 && error.code === 'SETTINGS_VERSION_REQUIRED',
  );
  assert.equal(await readToml(tomlPath), before);
});

test('two windows saving sequentially: the second gets 409 SETTINGS_CHANGED', async (t) => {
  const { service, tomlPath, builds } = await fixture(t);
  const shared = await state(service);

  const first = await service.patchSettings({ ...shared, values: { 'params.description': '窗口一' } });
  assert.equal(first.changed, true);

  await assert.rejects(
    service.patchSettings({ ...shared, values: { 'params.description': '窗口二' } }),
    (error) => error.statusCode === 409 && error.code === 'SETTINGS_CHANGED',
  );
  // 第一个窗口的写入没有被覆盖
  assert.equal(parseToml(await readToml(tomlPath)).values['params.description'], '窗口一');
  assert.equal(builds(), 1, 'the rejected write must not schedule a rebuild');
});

test('concurrent requests with the same version: exactly one succeeds', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const shared = await state(service);

  // 屏障精确交错：两个请求同时进入，只有队列内的第一个能看到原版本。
  const settled = await Promise.allSettled([
    service.patchSettings({ ...shared, values: { 'params.description': 'A' } }),
    service.patchSettings({ ...shared, values: { 'params.description': 'B' } }),
  ]);

  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one request may be applied');
  assert.equal(rejected.length, 1, 'the other must be rejected');
  assert.equal(rejected[0].reason.statusCode, 409);
  // 落盘值必须等于成功那一次请求提交的值，不能是两个请求的混合。
  const winner = fulfilled[0].value.appliedFields.length ? settled.indexOf(fulfilled[0]) : -1;
  const expected = winner === 0 ? 'A' : 'B';
  assert.equal(parseToml(await readToml(tomlPath)).values['params.description'], expected);
});

test('a failed task does not permanently block the queue', async (t) => {
  const { service, tomlPath } = await fixture(t);

  // 1) 故意的版本冲突失败
  await assert.rejects(
    service.patchSettings({ baseVersion: 'stale', schemaVersion: 'stale', values: {} }),
    (error) => error.statusCode === 428 || error.statusCode === 409,
  );
  // 2) 故意的非法 TOML 失败
  await fsp.writeFile(tomlPath, '[params\nbroken = \n');
  const broken = await service.readSettings();
  await assert.rejects(
    service.patchSettings({
      baseVersion: broken.versions.settings, schemaVersion: broken.versions.schema,
      values: { 'params.description': 'x' },
    }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_TOML',
  );
  // 3) 队列仍然接受后续请求
  await fsp.writeFile(tomlPath, TOML_FIXTURE);
  const versions = await state(service);
  const result = await service.patchSettings({ ...versions, values: { 'params.description': '恢复后' } });
  assert.equal(result.changed, true);
  assert.equal(parseToml(await readToml(tomlPath)).values['params.description'], '恢复后');
  assert.equal(service.queueDepth(), 0, 'queue is empty after all tasks settle');
});

test('manually edited TOML blocks the save with 409 and does not build', async (t) => {
  const { service, tomlPath, builds } = await fixture(t);
  const versions = await state(service);
  // 模拟外部编辑器保存
  await fsp.writeFile(tomlPath, `${TOML_FIXTURE.replace('"旧简介"', '"外部改的简介"')}`);

  await assert.rejects(
    service.patchSettings({ ...versions, values: { 'params.accent': '#112233' } }),
    (error) => error.statusCode === 409 && error.code === 'SETTINGS_CHANGED',
  );
  assert.equal(parseToml(await readToml(tomlPath)).values['params.description'], '外部改的简介');
  assert.equal(parseToml(await readToml(tomlPath)).values['params.accent'], '#7fb5b0');
  assert.equal(builds(), 0);
});

test('switching the theme schema blocks the save with 409 SCHEMA_CHANGED', async (t) => {
  const { service, themeRoot } = await fixture(t);
  const versions = await state(service);
  await fsp.writeFile(path.join(themeRoot, 'theme-config.schema.json'), JSON.stringify({
    sections: [{ id: 'other', fields: [{ path: 'params.accent', type: 'color' }] }],
  }));

  await assert.rejects(
    service.patchSettings({ ...versions, values: { 'params.description': 'x' } }),
    (error) => error.statusCode === 409 && error.code === 'SCHEMA_CHANGED',
  );
});

test('identityVersion is only required for author/avatar, not for plain theme edits', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const versions = await state(service);

  // 友链在别处变化（identity 版本变了）
  await fsp.writeFile(path.join(path.dirname(tomlPath), 'data', 'site.yaml'), YAML.stringify({
    author: 'Before', avatar: '/old.png', aboutTitle: 'About', about: ['hello'], links: [], friends: [{ name: 'F', url: 'https://f.example', desc: '', avatar: '' }],
  }));

  // 纯主题颜色修改不受影响
  const colors = await service.patchSettings({ ...versions, values: { 'params.accent': '#aabbcc' } });
  assert.equal(colors.changed, true);
  assert.equal(parseToml(await readToml(tomlPath)).values['params.accent'], '#aabbcc');

  // 改作者就必须带 identityVersion：新版本但不带 identityVersion → 428；
  // 带了过期的 identityVersion → 409 IDENTITY_CHANGED。
  const fresh = await state(service);
  await assert.rejects(
    service.patchSettings({ baseVersion: fresh.baseVersion, schemaVersion: fresh.schemaVersion, values: { 'params.author': 'NewAuthor' } }),
    (error) => error.statusCode === 428 && error.code === 'SETTINGS_VERSION_REQUIRED',
  );
  await assert.rejects(
    service.patchSettings({ ...fresh, identityVersion: versions.identityVersion, values: { 'params.author': 'NewAuthor' } }),
    (error) => error.statusCode === 409 && error.code === 'IDENTITY_CHANGED',
  );
  // 正确版本可以成功
  const ok = await service.patchSettings({ ...fresh, values: { 'params.author': 'NewAuthor' } });
  assert.equal(ok.changed, true);
});

test('invalid TOML returns 400 with position and leaves every file unchanged', async (t) => {
  const { service, tomlPath, siteDataFile, builds } = await fixture(t);
  const goodToml = await readToml(tomlPath);
  const goodSite = await fsp.readFile(siteDataFile, 'utf8');
  await fsp.writeFile(tomlPath, `${goodToml}\nduplicate = 1\nduplicate = 2\n`);
  const broken = await service.readSettings();

  await assert.rejects(
    service.patchSettings({
      baseVersion: broken.versions.settings, schemaVersion: broken.versions.schema,
      values: { 'params.description': 'x' },
    }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_TOML' && Number.isInteger(error.details?.line),
  );
  assert.equal(await fsp.readFile(siteDataFile, 'utf8'), goodSite);
  assert.equal(builds(), 0);

  // 原文保存同样被拒绝
  const afterBroken = await readToml(tomlPath);
  await assert.rejects(
    service.replaceSettingsRaw({
      raw: afterBroken,
      baseVersion: broken.versions.settings, schemaVersion: broken.versions.schema,
    }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_TOML',
  );
  assert.equal(await readToml(tomlPath), afterBroken);
});

test('unknown PATCH field is still 400 and never bypasses validation', async (t) => {
  const { service } = await fixture(t);
  const versions = await state(service);
  await assert.rejects(
    service.patchSettings({ ...versions, values: { 'params.notInSchema': 1 } }),
    (error) => error.statusCode === 400,
  );
});

test('menus are untouched when not submitted, and preserved when edited', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const before = await readToml(tomlPath);
  let versions = await state(service);

  // 1) 未提交 menus：菜单字节完全不变
  await service.patchSettings({ ...versions, values: { 'params.description': '只改简介' } });
  const afterNoMenu = await readToml(tomlPath);
  const menuRegion = (text) => text.slice(text.indexOf('[[menus.main]]'), text.indexOf('[otherSync]'));
  assert.equal(menuRegion(afterNoMenu), menuRegion(before), 'menus must not be rewritten');

  // 2) 提交等价菜单：仍不重写
  versions = await state(service);
  const currentMenus = (await service.readSettings()).menus;
  const noop = await service.patchSettings({ ...versions, menus: currentMenus });
  assert.equal(noop.changed, false);
  assert.equal(await readToml(tomlPath), afterNoMenu);

  // 3) 真的改菜单：identifier 保留，name 更新
  versions = await state(service);
  const changed = await service.patchSettings({
    ...versions,
    menus: [{ name: '首页改', url: '/', weight: 10 }, { name: '关于', url: '/about/', weight: 20 }],
  });
  assert.equal(changed.changed, true);
  const afterMenu = await readToml(tomlPath);
  assert.ok(afterMenu.includes('identifier = "home"'), 'identifier must survive a menu edit');
  assert.ok(afterMenu.includes('name = "首页改"'));
  assert.equal(parseToml(afterMenu).menus.length, 2);
});

test('menu weight 0 is written as 0 and never coerced to 10', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const versions = await state(service);
  await service.patchSettings({
    ...versions,
    menus: [{ name: '首页', url: '/', weight: 0 }, { name: '关于', url: '/about/', weight: 20 }],
  });
  const text = await readToml(tomlPath);
  assert.match(text, /weight = 0(\r?\n|$)/);
  assert.equal(parseToml(text).menus[0].weight, 0);
});

test('clearing menus is an explicit action that removes the blocks', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const versions = await state(service);
  const result = await service.patchSettings({ ...versions, menus: [] });
  assert.equal(result.changed, true);
  const text = await readToml(tomlPath);
  assert.equal(text.includes('menus.main'), false);
  assert.ok(text.includes('[params]'), 'other content survives');
  assert.deepEqual(parseToml(text).menus, []);
});

test('the raw save path synchronizes author/avatar with the same version rules', async (t) => {
  const { service, tomlPath, siteDataFile } = await fixture(t);
  const versions = await state(service);
  const before = await readToml(tomlPath);
  const nextRaw = before.replace('author = "Before"', 'author = "RawAuthor"');

  // 缺 identityVersion：因为作者发生变化，必须 428
  await assert.rejects(
    service.replaceSettingsRaw({ raw: nextRaw, baseVersion: versions.baseVersion, schemaVersion: versions.schemaVersion }),
    (error) => error.statusCode === 428,
  );
  assert.equal(await readToml(tomlPath), before);

  const result = await service.replaceSettingsRaw({
    raw: nextRaw,
    baseVersion: versions.baseVersion,
    schemaVersion: versions.schemaVersion,
    identityVersion: versions.identityVersion,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.identitySync.map((item) => item.yamlKey), ['author']);
  assert.equal(YAML.parse(await fsp.readFile(siteDataFile, 'utf8')).author, 'RawAuthor');
  assert.equal(parseToml(await readToml(tomlPath)).values['params.author'], 'RawAuthor');
});

test('the raw save path rejects invalid TOML without writing anything', async (t) => {
  const { service, tomlPath } = await fixture(t);
  const versions = await state(service);
  const before = await readToml(tomlPath);
  await assert.rejects(
    service.replaceSettingsRaw({
      raw: '[params]\nbroken = \n',
      baseVersion: versions.baseVersion, schemaVersion: versions.schemaVersion, identityVersion: versions.identityVersion,
    }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_TOML',
  );
  assert.equal(await readToml(tomlPath), before);
});

test('a second rename failure rolls back and never reports success', async (t) => {
  let renameCount = 0;
  const proxied = new Proxy(fsp, {
    get(target, key) {
      const value = target[key];
      if (key !== 'rename') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args) => {
        renameCount += 1;
        if (renameCount === 2) throw Object.assign(new Error('injected second rename failure'), { code: 'EPERM' });
        return fsp.rename(...args);
      };
    },
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-l1-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const themeRoot = path.join(root, 'themes', 'demo');
  const siteDataFile = path.join(root, 'data', 'site.yaml');
  const tomlPath = path.join(root, 'hugo.toml');
  await fsp.mkdir(path.dirname(siteDataFile), { recursive: true });
  await fsp.mkdir(themeRoot, { recursive: true });
  await fsp.writeFile(siteDataFile, YAML.stringify({ author: 'Before', avatar: '/old.png', aboutTitle: '', about: [], links: [], friends: [] }));
  await fsp.writeFile(tomlPath, TOML_FIXTURE);
  await fsp.writeFile(path.join(themeRoot, 'theme-config.schema.json'), JSON.stringify(SCHEMA));

  let builds = 0;
  const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const atomic = createAtomicFileService({ scheduleBuild: () => { builds += 1; }, httpError, fsApi: proxied });
  const fileTransaction = createFileTransactionService({
    stageFile: atomic.stageFile, atomicWrite: atomic.atomicWrite, scheduleBuild: () => { builds += 1; }, fsApi: proxied,
  });
  const service = createSiteSettingsService({
    repoRoot: root, siteDataFile, themeRoot, fileTransaction, atomicWrite: atomic.atomicWrite, httpError, maxBodyBytes: 1024 * 1024,
  });

  const beforeToml = await readToml(tomlPath);
  const beforeSite = await fsp.readFile(siteDataFile, 'utf8');
  const versions = await state(service);

  // 作者变更会写两个文件：第一个 rename 成功、第二个失败，必须回滚第一个。
  await assert.rejects(
    service.patchSettings({ ...versions, values: { 'params.author': 'RollbackAuthor' } }),
    (error) => /injected second rename failure/.test(error.message),
  );
  assert.equal(await readToml(tomlPath), beforeToml, 'hugo.toml must be restored');
  assert.equal(await fsp.readFile(siteDataFile, 'utf8'), beforeSite, 'site.yaml must be restored');
  assert.equal(builds, 0, 'a rolled back save must not schedule a rebuild');
  const leftovers = (await fsp.readdir(root)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a schema with a comment-only or complex field is reported and not editable', async (t) => {
  const { service, themeRoot, tomlPath } = await fixture(t);
  await fsp.writeFile(path.join(themeRoot, 'theme-config.schema.json'), JSON.stringify({
    sections: [{ id: 'main', fields: [
      { path: 'params.author', type: 'string' },
      { path: 'params.multilineNote', type: 'string' },
    ] }],
  }));
  const data = await service.readSettings();
  assert.equal(data.fieldModes['params.author'].editable, true);
  assert.equal(data.fieldModes['params.multilineNote'].editable, false);
  assert.equal(data.fieldModes['params.multilineNote'].reason, 'multiline');
  // 强行提交会被拒绝，且不写文件
  const before = await readToml(tomlPath);
  await assert.rejects(
    service.patchSettings({
      baseVersion: data.versions.settings, schemaVersion: data.versions.schema,
      values: { 'params.multilineNote': '试图覆盖' },
    }),
    (error) => error.statusCode === 400 && error.code === 'FIELD_NOT_EDITABLE',
  );
  assert.equal(await readToml(tomlPath), before);
});

// ---- 纯 domain 层用例（不经过服务） ----

test('TOML patcher preserves CRLF, BOM, inline comments and unknown structures', () => {
  const source = '\uFEFF[params]\r\n  author = "old"   # 注释\r\n  box = { a = 1 }\r\n  multi = """x\r\ny"""\r\n\r\n[unknown]\r\n  arr = [[1, 2]]\r\n';
  const out = patchTomlValue(source, 'params.author', 'new');
  assert.equal(out.charCodeAt(0), 0xfeff, 'BOM preserved');
  assert.ok(out.includes('\r\n'), 'CRLF preserved');
  assert.ok(out.includes('author = "new"   # 注释'), 'spacing and inline comment preserved');
  assert.ok(out.includes('box = { a = 1 }'));
  assert.ok(out.includes('multi = """x'));
  assert.ok(out.includes('  arr = [[1, 2]]'));
  assert.equal(validateToml(out).ok, true);
});

test('TOML patcher refuses multiline, inline-table and array-table targets', () => {
  const inline = '[params]\nbox = { a = 1 }\n';
  assert.throws(() => patchTomlValue(inline, 'params.box.b', 2), (error) => error.code === 'FIELD_NOT_EDITABLE');
  const multi = '[params]\nnote = """a\nb"""\n';
  assert.throws(() => patchTomlValue(multi, 'params.note', 'x'), (error) => error.code === 'FIELD_NOT_EDITABLE');
  const arrayTable = '[[menus.main]]\n  name = "A"\n  url = "/"\n  weight = 10\n';
  assert.throws(() => patchTomlValue(arrayTable, 'menus.main.name', 'B'), (error) => error.code === 'FIELD_NOT_EDITABLE');
});

test('menu patcher keeps extras/comments and treats 0 as a real weight', () => {
  const source = [
    '[[menus.main]]',
    '  name = "Home" # 主页',
    '  url = "/"',
    '  weight = 0',
    '  identifier = "home-id"',
    '  [menus.main.params]',
    '    icon = "house"',
    '',
  ].join('\r\n');
  const out = patchMenus(source, [{ name: 'Home2', url: '/', weight: 0 }]);
  assert.ok(out.includes('identifier = "home-id"'));
  assert.ok(out.includes('[menus.main.params]'));
  assert.ok(out.includes('icon = "house"'));
  assert.ok(out.includes('# 主页'));
  assert.match(out, /weight = 0/);
  assert.ok(out.includes('\r\n'));
  assert.equal(parseToml(out).menus[0].name, 'Home2');
});

test('menu patcher returns identical bytes when nothing changed', () => {
  const source = '[[menus.main]]\r\n  name = "A"\r\n  url = "/"\r\n  weight = 10\r\n  identifier = "a"\r\n';
  const out = patchMenus(source, parseToml(source).menus);
  assert.equal(out, source);
});

test('analyzeToml reports edit modes for declared fields only', () => {
  const analysis = analyzeToml('[params]\nauthor = "a"\nbox = { a = 1 }\n', {
    sections: [{ fields: [
      { path: 'params.author' }, { path: 'params.box.b' }, { path: 'params.missing' },
    ] }],
  });
  assert.equal(analysis.fields['params.author'].editable, true);
  assert.equal(analysis.fields['params.box.b'].editable, false);
  assert.equal(analysis.fields['params.box.b'].reason, 'inline-value');
  assert.equal(analysis.fields['params.missing'].editable, true);
  assert.equal(analysis.fields['params.missing'].reason, 'append');
});
