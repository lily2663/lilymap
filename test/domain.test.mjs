import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { formatYamlValue, parseFrontMatter, patchFrontMatter } from '../src/domain/front-matter.mjs';
import { decryptProtectedBody, encryptProtectedBody } from '../src/domain/protected-content.mjs';
import { normalizeLayout, normalizeModuleManifest, validateLayoutAgainstRegistry } from '../src/domain/layout.mjs';
import { validateFriends, validateProfile } from '../src/domain/profile.mjs';
import { parseToml, patchMenus, patchTomlValue } from '../src/domain/toml.mjs';
import { parseYaml } from '../src/domain/value.mjs';
import { validateMenus, validateThemeSettingsPatch } from '../src/domain/theme-config.mjs';
import { sameValue, selectOptionIndex, selectOptionValue } from '../public/js/core/value.js';

test('front matter round-trips article metadata without changing the body', () => {
  const source = '---\ntitle: "Before"\ntags:\n  - "one"\nparams:\n  protected: false\n---\nBody\n';
  const patched = patchFrontMatter(source, { title: 'After', tags: ['two'], protected: true });
  const parsed = parseFrontMatter(patched);
  assert.equal(parsed.frontMatter.title, 'After');
  assert.deepEqual(parsed.frontMatter.tags, ['two']);
  assert.equal(parsed.frontMatter.params.protected, true);
  assert.equal(parsed.body, 'Body\n');
});

test('YAML values remain quoted and escaped', () => {
  assert.equal(formatYamlValue('a "quote" \\ path'), '"a \\"quote\\" \\\\ path"');
});

test('TOML settings and menus can be patched independently', () => {
  const source = '[params]\nauthor = "Lily"\n\n[[menus.main]]\n  name = "Home"\n  url = "/"\n  weight = 10\n';
  const setting = patchTomlValue(source, 'params.author', 'Lily Zero');
  const menus = patchMenus(setting, [{ name: 'Posts', url: '/posts/', weight: 20 }]);
  const parsed = parseToml(menus);
  assert.equal(parsed.values['params.author'], 'Lily Zero');
  assert.deepEqual(parsed.menus, [{ name: 'Posts', url: '/posts/', weight: 20 }]);
});

test('protected article encryption is reversible and rejects a wrong password', () => {
  const payload = encryptProtectedBody('page', 'secret body', 'correct');
  assert.equal(decryptProtectedBody(payload, 'correct'), 'secret body');
  assert.throws(() => decryptProtectedBody(payload, 'wrong'), (error) => error.status === 400);
});

test('YAML domain parser rejects non-object roots', () => {
  assert.deepEqual(parseYaml('title: Lily\n', '测试'), { title: 'Lily' });
  assert.throws(() => parseYaml('- one\n', '测试'), /必须是 YAML 对象/);
});

test('profiles and friend links are normalized at the domain boundary', () => {
  assert.deepEqual(validateProfile({ author: ' Lily ', aboutTitle: '', about: [' hello '], links: [{ label: 'Site', url: 'https://example.com/' }] }), {
    author: 'Lily', aboutTitle: '', about: ['hello'], links: [{ label: 'Site', url: 'https://example.com/' }],
  });
  assert.equal(validateFriends([{ name: 'Friend', url: 'https://example.com', desc: '', avatar: '/avatar.png' }])[0].name, 'Friend');
  assert.throws(() => validateFriends([{ name: 'Bad', url: 'javascript:alert(1)', desc: '', avatar: '' }]), (error) => error.statusCode === 400);
});

test('layout modules enforce slot and schema contracts', () => {
  const layout = normalizeLayout({ kind: 'home', slots: { main: [{ id: 'hero', module: 'welcome', config: { enabled: true } }] } }, '首页');
  const manifest = normalizeModuleManifest('welcome', 'id: welcome\nallowedSlots:\n  - home.main\nschema:\n  enabled:\n    type: boolean\n', 'built-in');
  assert.doesNotThrow(() => validateLayoutAgainstRegistry(layout, { welcome: manifest }));
  assert.throws(() => validateLayoutAgainstRegistry({ ...layout, slots: { main: [{ ...layout.slots.main[0], config: { enabled: 'yes' } }] } }, { welcome: manifest }), /必须是布尔值/);
});

test('module protocol defaults legacy manifests to v1 and rejects unknown major versions', () => {
  const legacy = normalizeModuleManifest('quote', 'id: quote\nallowedSlots:\n  - home.main\n', 'site');
  assert.equal(legacy.apiVersion, 'lily-module/v1');
  assert.throws(() => normalizeModuleManifest('quote', 'apiVersion: lily-module/v2\nid: quote\nallowedSlots:\n  - home.main\n', 'site'), /不支持的 apiVersion/);
});


test('select configuration preserves non-string protocol values', () => {
  const manifest = normalizeModuleManifest('mode-demo', YAML.stringify({
    apiVersion: 'lily-module/v1',
    id: 'mode-demo',
    version: '1.2.3',
    allowedSlots: ['home.main'],
    defaults: { mode: 2 },
    schema: { mode: { type: 'select', options: [{ value: 'one' }, { value: 2 }, { value: true }, { value: null }, { value: { kind: 'object', level: 1 } }] } },
  }), 'site');
  const objectValue = { level: 1, kind: 'object' };
  const layout = normalizeLayout({ kind: 'home', slots: { main: [{ id: 'mode', module: 'mode-demo', config: { mode: objectValue } }] } }, '首页');
  assert.doesNotThrow(() => validateLayoutAgainstRegistry(layout, { 'mode-demo': manifest }));
  assert.equal(selectOptionIndex(manifest.schema.mode, objectValue), 4);
  assert.deepEqual(selectOptionValue(manifest.schema.mode, 4), { kind: 'object', level: 1 });
  assert.equal(sameValue({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
});

test('module manifest normalization enforces the published structural contract', () => {
  assert.throws(() => normalizeModuleManifest('quote', 'id: quote\nversion: v1\nallowedSlots:\n  - home.main\n', 'site'), /SemVer/);
  assert.throws(() => normalizeModuleManifest('quote', 'id: quote\nallowedSlots:\n  - home.main\n  - home.main\n', 'site'), /不能重复/);
  assert.throws(() => normalizeModuleManifest('quote', 'id: quote\nallowedSlots:\n  - Home.main\n', 'site'), /allowedSlots/);
  assert.throws(() => normalizeModuleManifest('quote', 'id: quote\nallowedSlots:\n  - home.main\nschema:\n  mode:\n    type: magic\n', 'site'), /schema\.mode\.type/);
});

test('theme settings patches and menus are validated at the domain boundary', () => {
  const schema = { sections: [{ id: 'theme', fields: [
    { path: 'params.enabled', type: 'boolean' },
    { path: 'params.size', type: 'number', min: 8, max: 32 },
    { path: 'params.mode', type: 'select', options: [{ value: 'a' }, { value: 'b' }] },
    { path: 'params.accent', type: 'color' },
    { path: 'params.api', type: 'url' },
  ] }] };
  assert.deepEqual(validateThemeSettingsPatch(schema, { 'params.enabled': true, 'params.size': 16, 'params.mode': 'b', 'params.accent': '#AABBCC', 'params.api': 'https://example.com' }), {
    'params.enabled': true, 'params.size': 16, 'params.mode': 'b', 'params.accent': '#AABBCC', 'params.api': 'https://example.com',
  });
  assert.throws(() => validateThemeSettingsPatch(schema, { 'params.size': 100 }), (error) => error.statusCode === 400);
  assert.throws(() => validateThemeSettingsPatch(schema, { 'params.unknown': true }), (error) => error.statusCode === 400);
  assert.doesNotThrow(() => validateMenus([{ name: '首页', url: '/', weight: 10 }]));
  assert.throws(() => validateMenus([{ name: '', url: '/', weight: 10 }]), (error) => error.statusCode === 400);
});

test('theme protocol fixtures remain compatible with LilyMap', { skip: !process.env.LILY_TEST_THEME_PATH }, () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(process.env.LILY_TEST_THEME_PATH, 'docs/protocol/v1-fixtures.json'), 'utf8'));
  for (const fixture of fixtures.valid || []) {
    assert.doesNotThrow(() => normalizeModuleManifest(fixture.fileId, YAML.stringify(fixture.manifest), 'fixture'), fixture.name);
  }
  for (const fixture of fixtures.invalid || []) {
    assert.throws(() => normalizeModuleManifest(fixture.fileId, YAML.stringify(fixture.manifest), 'fixture'), undefined, fixture.name);
  }
});
