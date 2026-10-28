import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { isValidRfc3339, validateThemeSettingsPatch } from '../src/domain/theme-config.mjs';

// L2-02：RSS / 分享设置入口。
// 核心约束：
//   1) UI 完全按主题 schema 动态渲染，不硬编码字段清单；
//   2) schema 缺字段（主题还没声明）时界面不报错、不显示该字段；
//   3) 保存其他设置绝不自动写 params.rss.updated。

const settled = () => new Promise((resolve) => setImmediate(resolve));

function makeElement(id, attrs = {}) {
  return {
    id, value: attrs.value == null ? '' : String(attrs.value), checked: Boolean(attrs.checked), disabled: false,
    textContent: '', dataset: {}, attributes: {}, isConnected: true,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    remove() { this.isConnected = false; },
    parentElement: { remove() {} },
  };
}

// 只驱动真实 public/js/features/settings.js，用受控 DOM stub 取代浏览器。
function harness({ data }) {
  const schema = data.schema;
  const elements = new Map();
  const requests = [];
  const notices = [];
  const state = { view: 'settings' };
  const controls = new Map();

  const fields = [];
  for (const section of (Array.isArray(schema?.sections) ? schema.sections : [])) {
    if (!section || !Array.isArray(section.fields)) continue;
    for (const field of section.fields) if (field && typeof field.path === 'string' && field.path) fields.push(field);
  }
  for (const field of fields) {
    const present = data.values && Object.hasOwn(data.values, field.path);
    const value = present ? data.values[field.path] : field.default;
    const element = makeElement(field.path);
    if (field.type === 'boolean') element.checked = Boolean(value);
    else element.value = value === undefined ? '' : String(value);
    controls.set(field.path, element);
  }

  const main = makeElement('main');
  elements.set('main', main);
  for (const id of ['menus', 'add-menu', 'save-settings', 'save-raw-settings']) elements.set(id, makeElement(id));
  let markup = '';
  Object.defineProperty(main, 'innerHTML', { get: () => markup, set: (value) => { markup = value; } });

  const document = {
    querySelector(selector) {
      const config = /^\[data-config="(.+)"\]$/.exec(selector);
      if (config) return controls.get(config[1]) || null;
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.menu-item') return [];
      return [];
    },
  };

  const fixture = { state, requests, notices, controls, main, markup: () => markup };
  const source = fs.readFileSync(new URL('../public/js/features/settings.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const context = {
    state,
    $: (selector) => elements.get(selector.slice(1)) || null,
    api: async (...args) => { requests.push(args); return fixture.api(...args); },
    document,
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    toast: (message) => notices.push(message),
    setTimeout: (callback) => { callback(); return 0; },
    sameValue: (left, right) => {
      if (Object.is(left, right)) return true;
      if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
      }
      return false;
    },
    selectOptionIndex: (definition, value) => (definition?.options || []).findIndex((option) => Object.is(option.value, value)),
    selectOptionLabel: (option) => String(option?.label ?? option?.value ?? ''),
    selectOptionValue: (definition, index) => definition?.options?.[Number(index)]?.value,
    ApiError: class ApiError extends Error {
      constructor(message, { status = 0, code = '', details = null, network = false } = {}) {
        super(message); this.status = status; this.code = code; this.details = details; this.network = network;
      }
      get isUnchanged() { return false; }
      get isUnconfirmed() { return this.network || this.status === 0; }
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.renderSettings = renderSettings;`, context, { filename: 'settings.js' });
  fixture.$ = (id) => elements.get(id) || null;
  fixture.api = async (url, options = {}) => {
    if (url === '/api/settings' && (options.method || 'GET') === 'GET') return data;
    throw new Error(`Unexpected API request: ${options.method || 'GET'} ${url}`);
  };
  fixture.render = async () => {
    await context.renderSettings({ page: (_, __, actions = '') => actions, bindCommon() {}, refresh() {} });
    elements.set('raw-settings', makeElement('raw-settings', { value: data.raw || '' }));
  };
  fixture.triggerSave = async () => {
    const button = elements.get('save-settings');
    assert.ok(button && typeof button.onclick === 'function', 'save-settings handler must be bound');
    await button.onclick();
    await settled();
  };
  fixture.patchBody = () => {
    const patch = requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH');
    return patch ? JSON.parse(patch[1].body) : null;
  };
  return fixture;
}

const SHARE_SCHEMA = {
  sections: [
    { id: 'identity', label: '站点身份', fields: [{ path: 'params.author', label: '作者', type: 'string' }] },
    {
      id: 'share',
      label: '分享与订阅',
      fields: [
        { path: 'params.shareImage', label: '站点默认分享图', type: 'url', help: '主题原始 help' },
        { path: 'params.rss.updated', label: 'RSS 内容更新时间', type: 'string', help: '主题原始 help' },
        { path: 'services.rss.limit', label: 'RSS 条目数量上限', type: 'number', default: 0, min: 0, max: 100, step: 1 },
      ],
    },
  ],
};

function shareData(overrides = {}) {
  return {
    schema: SHARE_SCHEMA,
    values: { 'params.author': 'lily', 'params.shareImage': '/share/lily-house.png', 'services.rss.limit': 20 },
    menus: [],
    raw: 'RAW',
    versions: { settings: 'vs1', schema: 'vc1', identity: 'vi1' },
    capabilities: { settingsOptimisticLock: true },
    fieldModes: {},
    menusMode: { editable: true },
    valid: true,
    syntaxError: null,
    ...overrides,
  };
}

test('L2-02: share/rss fields render from the schema with explicit help text', async () => {
  const h = harness({ data: shareData() });
  await h.render();
  const markup = h.markup();
  assert.match(markup, /data-config="params\.shareImage"/);
  assert.match(markup, /data-config="params\.rss\.updated"/);
  assert.match(markup, /data-config="services\.rss\.limit"/);
  // 帮助文案必须比主题的原始 help 更明确
  assert.match(markup, /站点默认分享图（1200×630 PNG\/JPG）/);
  assert.match(markup, /未给文章单独设置 shareImage 时使用/);
  assert.match(markup, /仅在 RSS 模板或摘要策略真实变更时手动更新一次/);
  assert.match(markup, /普通保存设置或重建站点不要改它/);
  assert.doesNotMatch(markup, /主题原始 help/);
});

test('L2-02: a schema without the share/rss fields renders without error and without those controls', async () => {
  // 模拟主题 schema 尚未声明这些字段（themes/ 由 Lead 维护，LilyMap 必须容错）
  const h = harness({ data: shareData({
    schema: { sections: [{ id: 'identity', label: '站点身份', fields: [{ path: 'params.author', label: '作者', type: 'string' }] }] },
    values: { 'params.author': 'lily' },
  }) });
  await h.render();
  const markup = h.markup();
  assert.doesNotMatch(markup, /data-config="params\.shareImage"/);
  assert.doesNotMatch(markup, /data-config="params\.rss\.updated"/);
  assert.match(markup, /data-config="params\.author"/, '其余字段必须照常渲染');
  assert.equal(h.notices.length, 0, '缺字段时不应弹出任何错误提示');
});

test('L2-02: malformed schema fragments degrade instead of throwing', async () => {
  // 主题 schema 是外部文件：sections 不是数组、section.fields 缺失、字段缺 path 都必须容错
  for (const schema of [
    undefined,
    null,
    {},
    { sections: 'nope' },
    { sections: [{ id: 'x', label: '坏 section' }] },
    { sections: [{ id: 'x', label: '含坏字段', fields: [null, { label: '没有 path' }, { path: '', type: 'string' }] }] },
  ]) {
    const h = harness({ data: shareData({ schema, values: {} }) });
    await assert.doesNotReject(() => h.render(), `schema ${JSON.stringify(schema)} 不能让设置页崩溃`);
  }
});

test('L2-02: saving an unrelated setting never writes params.rss.updated', async () => {
  const h = harness({ data: shareData() });
  await h.render();
  h.controls.get('params.author').value = '新作者';
  await h.triggerSave();
  const body = h.patchBody();
  assert.ok(body, '应该发出 PATCH');
  assert.deepEqual(Object.keys(body.values), ['params.author']);
  assert.equal(Object.hasOwn(body.values, 'params.rss.updated'), false,
    '普通保存绝不能把 rss.updated 写成当前时间');
});

test('L2-02: saving rss.updated sends the exact text the user typed', async () => {
  const h = harness({ data: shareData() });
  await h.render();
  h.controls.get('params.rss.updated').value = '2026-10-29T01:00:00+08:00';
  await h.triggerSave();
  const body = h.patchBody();
  assert.deepEqual(Object.keys(body.values), ['params.rss.updated']);
  assert.equal(body.values['params.rss.updated'], '2026-10-29T01:00:00+08:00',
    '必须原样提交，不能自动填成 now');
});

test('L2-02: an unchanged rss.updated is never submitted', async () => {
  const h = harness({ data: shareData({ values: { 'params.rss.updated': '2026-01-01T00:00:00+08:00' } }) });
  await h.render();
  h.controls.get('params.shareImage').value = '/share/new.png';
  await h.triggerSave();
  const body = h.patchBody();
  assert.deepEqual(Object.keys(body.values), ['params.shareImage']);
});

test('L2-02: rfc3339 validation rejects invalid timestamps before any write', () => {
  const schema = { sections: [{ id: 'share', fields: [{ path: 'params.rss.updated', type: 'string', format: 'rfc3339' }] }] };
  assert.deepEqual(validateThemeSettingsPatch(schema, { 'params.rss.updated': '2026-10-29T01:00:00+08:00' }), { 'params.rss.updated': '2026-10-29T01:00:00+08:00' });
  for (const bad of ['', 'now', '2026-10-29', '2026-02-30T00:00:00+08:00', '2026-10-29T01:00:00']) {
    assert.throws(() => validateThemeSettingsPatch(schema, { 'params.rss.updated': bad }), /值无效/, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('L2-02: schema without a format declaration keeps the old permissive behaviour', () => {
  // 旧 schema 不声明 format 时必须仍然能保存，否则升级 LilyMap 会锁死现有站点
  const schema = { sections: [{ id: 'share', fields: [{ path: 'params.rss.updated', type: 'string' }] }] };
  assert.doesNotThrow(() => validateThemeSettingsPatch(schema, { 'params.rss.updated': '任意文本' }));
});

test('L2-02: shareImage url validation accepts local paths and rejects script schemes', () => {
  const schema = { sections: [{ id: 'share', fields: [{ path: 'params.shareImage', type: 'url' }] }] };
  for (const good of ['', '/share/lily-house.png', 'https://cdn.example/x.png', './local.png']) {
    assert.doesNotThrow(() => validateThemeSettingsPatch(schema, { 'params.shareImage': good }), `${good} 应被接受`);
  }
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'share/x.png']) {
    assert.throws(() => validateThemeSettingsPatch(schema, { 'params.shareImage': bad }), /值无效/, `${bad} 应被拒绝`);
  }
});

test('L2-02: isValidRfc3339 handles leap years and offsets strictly', () => {
  assert.equal(isValidRfc3339('2024-02-29T00:00:00+00:00'), true);
  assert.equal(isValidRfc3339('2026-02-29T00:00:00+00:00'), false, '2026 不是闰年');
  assert.equal(isValidRfc3339('2026-12-31T23:59:59Z'), true);
  assert.equal(isValidRfc3339('2026-12-31T23:59:60+08:00'), true, '允许闰秒');
  assert.equal(isValidRfc3339('2026-12-31T23:59:59+24:00'), false);
  assert.equal(isValidRfc3339(20261029), false);
});
