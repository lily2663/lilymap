import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// 只驱动 public/js/features/settings.js 的真实处理逻辑，用受控 DOM stub 替代浏览器。
// 不发起网络请求、不写文件：所有 api() 调用都由测试注入的假实现接管。

const settled = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const SCHEMA = {
  sections: [
    { id: 'identity', label: '站点身份', fields: [
      { path: 'params.description', label: '站点描述', type: 'string' },
      { path: 'params.author', label: '作者', type: 'string' },
      { path: 'params.avatar', label: '头像', type: 'url' },
    ] },
    { id: 'theme', label: '主题外观', fields: [
      { path: 'params.webFonts', label: '在线字体', type: 'boolean', default: false },
      { path: 'params.mode', label: '模式', type: 'select', options: [{ value: 1, label: '一' }, { value: 2, label: '二' }] },
      { path: 'params.particles', label: '粒子', type: 'number', default: 30 },
    ] },
  ],
};

function makeElement(id, attrs = {}) {
  return {
    // DOM 输入控件的 value 永远是字符串：菜单 weight 是数字，必须在这里统一转换。
    id, value: attrs.value == null ? '' : String(attrs.value), checked: Boolean(attrs.checked), disabled: false,
    textContent: '', dataset: {}, attributes: {}, isConnected: true,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    remove() { this.isConnected = false; },
    parentElement: { remove() {} },
  };
}

// settings.js 只用 document.querySelector('[data-config="..."]') 读取字段控件，
// 用 document.querySelectorAll('.menu-item') 读取菜单；其余通过 $(id)。
function harness({ data, initial = {} } = {}) {
  const settings = data || {
    schema: SCHEMA,
    values: {
      'params.description': '旧简介',
      'params.author': 'lily',
      'params.avatar': '/a.png',
      'params.webFonts': false,
      'params.mode': 1,
      'params.particles': 0, // 0 是有效值，不能与缺省混淆
    },
    menus: [{ name: '首页', url: '/', weight: 10, identifier: 'home' }],
    raw: 'RAW-TOML',
    versions: { settings: 'vs1', schema: 'vc1', identity: 'vi1' },
    capabilities: { settingsOptimisticLock: true, settingsDiff: true },
    fieldModes: {},
    menusMode: { editable: true, reason: 'replace' },
    valid: true,
    syntaxError: null,
  };

  const elements = new Map();
  const requests = [];
  const notices = [];
  const state = { view: 'settings' };
  const controls = new Map();
  for (const section of SCHEMA.sections) {
    for (const field of section.fields) {
      const value = Object.hasOwn(settings.values, field.path) ? settings.values[field.path] : field.default;
      const element = makeElement(field.path);
      if (field.type === 'boolean') element.checked = Boolean(value);
      else element.value = value === undefined ? '' : String(value);
      controls.set(field.path, element);
    }
  }
  for (const [key, value] of Object.entries(initial)) {
    const element = controls.get(key);
    if (!element) continue;
    if (typeof value === 'boolean') element.checked = value;
    else element.value = String(value);
  }

  // 一个 .menu-item 包装：querySelector('[data-menu=xxx]') 返回该键的输入控件。
  function makeMenuItem(menu) {
    const wrapper = {
      inputs: {},
      querySelector(selector) {
        const key = selector.replace(/^\[data-menu=|\]$/g, '');
        if (!wrapper.inputs[key]) wrapper.inputs[key] = makeElement(`${key}-${menu[key]}`, { value: menu[key] });
        return wrapper.inputs[key];
      },
      set(key, value) { wrapper.querySelector(`[data-menu=${key}]`).value = String(value); },
    };
    return wrapper;
  }
  const menuItems = (settings.menus || []).map(makeMenuItem);

  const main = makeElement('main');
  // $('#main') 必须可用，否则 renderSettings 无法写入页面骨架。
  elements.set('main', main);
  // 页面骨架里的固定 id 在真实 DOM 中由 innerHTML 建立；stub 需要预先注册，
  // 否则 $('#menus') / $('#add-menu') 会返回 null。
  for (const id of ['menus', 'add-menu', 'save-settings', 'save-raw-settings']) elements.set(id, makeElement(id));
  let markup = '';
  Object.defineProperty(main, 'innerHTML', {
    get: () => markup,
    set: (value) => { markup = value; },
  });

  const document = {
    querySelector(selector) {
      const config = /^\[data-config="(.+)"\]$/.exec(selector);
      if (config) return controls.get(config[1]) || null;
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.menu-item') return menuItems;
      return [];
    },
    querySelectorAll2: null,
  };

  const fixture = {
    state, requests, notices, controls, main,
    setMenu(index, key, value) { menuItems[index].set(key, value); },
    removeMenu(index) { menuItems.splice(index, 1); },
    addMenu(menu) {
      const wrapper = makeMenuItem(menu);
      menuItems.push(wrapper);
      return wrapper;
    },
    // 默认只应答初始 GET；其它请求视为测试错误（必须由用例显式接管）。
    api: async (url, options = {}) => {
      if (url === '/api/settings' && (options.method || 'GET') === 'GET') return settings;
      throw new Error(`Unexpected API request: ${options.method || 'GET'} ${url}`);
    },
    render: null,
  };

  const source = fs.readFileSync(new URL('../public/js/features/settings.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const context = {
    state,
    $: (selector) => elements.get(selector.slice(1)) || null,
    api: (...args) => { requests.push(args); return fixture.api(...args); },
    document,
    esc: (value) => String(value ?? ''),
    toast: (message) => notices.push(message),
    setTimeout: (callback) => { callback(); return 0; },
    sameValue: (left, right) => {
      if (Object.is(left, right)) return true;
      if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index] || (typeof item === 'object' && item !== null && JSON.stringify(item) === JSON.stringify(right[index])));
      }
      if (left && right && typeof left === 'object' && typeof right === 'object') {
        const a = Object.keys(left).sort(); const b = Object.keys(right).sort();
        return a.length === b.length && a.every((key, index) => key === b[index] && (Object.is(left[key], right[key]) || (typeof left[key] === 'object' && JSON.stringify(left[key]) === JSON.stringify(right[key]))));
      }
      return false;
    },
    selectOptionIndex: (definition, value) => (definition?.options || []).findIndex((option) => Object.is(option.value, value)),
    selectOptionLabel: (option) => String(option?.label ?? option?.value ?? ''),
    selectOptionValue: (definition, index) => definition?.options?.[Number(index)]?.value,
    // ApiError 由 api.js 提供；features 只用 instanceof 判断，这里给出等价实现。
    ApiError: class ApiError extends Error {
      constructor(message, { status = 0, code = '', details = null, network = false } = {}) {
        super(message); this.status = status; this.code = code; this.details = details; this.network = network;
      }
      get isConflict() { return this.status === 409; }
      get isUnconfirmed() { return this.network || this.status === 0; }
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.renderSettings = renderSettings;`, context, { filename: 'settings.js' });
  fixture.ApiError = context.ApiError;
  fixture.$ = (id) => elements.get(id) || null;
  fixture.render = async () => {
    await context.renderSettings({ page: (_, __, actions = '') => actions, bindCommon() {}, refresh() {} });
    // 原文编辑框的初始内容来自服务器返回的 raw；真实 DOM 由 innerHTML 生成，
    // stub 需要在校验前补上当前值。
    elements.set('raw-settings', makeElement('raw-settings', { value: settings.raw }));
    // 真实浏览器会解析 innerHTML 里的 disabled 属性；stub 需要照做，
    // 否则“锁定字段”用例无法验证渲染结果，只会测到 stub 自己。
    for (const match of markup.matchAll(/<(?:input|select)[^>]*data-config="([^"]+)"[^>]*>/g)) {
      const control = controls.get(match[1]);
      if (control) control.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    }
  };
  // 触发真实的保存按钮处理器；不存在则报错，避免测试静默通过。
  fixture.triggerSave = async () => {
    const button = elements.get('save-settings');
    assert.ok(button && typeof button.onclick === 'function', 'save-settings handler must be bound');
    await button.onclick();
    await settled();
  };
  return fixture;
}

test('settings: saving with no edits sends no request and shows a no-change notice', async () => {
  const h = harness();
  await h.render();
  await h.triggerSave();
  assert.equal(h.requests.filter(([url, options]) => url === '/api/settings' && options?.method === 'PATCH').length, 0);
  assert.match(h.notices.at(-1), /没有检测到修改/);
});

test('settings: a single field change submits only that key', async () => {
  const h = harness();
  await h.render();
  h.controls.get('params.description').value = '新简介';
  await h.triggerSave();
  const patch = h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH');
  assert.ok(patch, 'a PATCH request should be sent');
  const body = JSON.parse(patch[1].body);
  assert.deepEqual(Object.keys(body.values), ['params.description']);
  assert.equal(body.values['params.description'], '新简介');
  assert.equal(body.baseVersion, 'vs1');
  assert.equal(body.schemaVersion, 'vc1');
  assert.equal(Object.hasOwn(body, 'identityVersion'), false, 'no identity version for a non-identity edit');
  assert.equal(Object.hasOwn(body, 'menus'), false, 'menus omitted when unchanged');
});

test('settings: author/avatar edits carry identityVersion', async () => {
  const h = harness();
  await h.render();
  h.controls.get('params.author').value = '新作者';
  await h.triggerSave();
  const body = JSON.parse(h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH')[1].body);
  assert.deepEqual(Object.keys(body.values), ['params.author']);
  assert.equal(body.identityVersion, 'vi1');
});

test('settings: unchanged menus are omitted; edited menus are submitted', async () => {
  const h = harness();
  await h.render();
  h.controls.get('params.description').value = '改简介';
  await h.triggerSave();
  let body = JSON.parse(h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH')[1].body);
  assert.equal(Object.hasOwn(body, 'menus'), false);

  h.requests.length = 0;
  h.setMenu(0, 'name', '首页改');
  h.controls.get('params.description').value = '再改简介';
  await h.triggerSave();
  body = JSON.parse(h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH')[1].body);
  assert.deepEqual(body.menus, [{ name: '首页改', url: '/', weight: 10 }]);
});

test('settings: false/0 are compared by real type, not by truthiness', async () => {
  const h = harness();
  await h.render();
  // 把 particles 从 0 改成 5 必须被识别为变化
  h.controls.get('params.particles').value = '5';
  await h.triggerSave();
  let body = JSON.parse(h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH')[1].body);
  assert.equal(body.values['params.particles'], 5);

  // 把 webFonts 从 false 改成 true，再改回 false：不应提交
  h.requests.length = 0;
  h.controls.get('params.webFonts').checked = true;
  await h.triggerSave();
  body = JSON.parse(h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH')[1].body);
  assert.equal(body.values['params.webFonts'], true);
});

test('settings: an empty number input blocks the save instead of writing 0 or NaN', async () => {
  const h = harness();
  await h.render();
  h.controls.get('params.particles').value = '';
  await h.triggerSave();
  assert.equal(h.requests.filter(([url, options]) => url === '/api/settings' && options?.method === 'PATCH').length, 0);
  assert.match(h.notices.at(-1), /数字字段为空/);
});

test('settings: duplicate clicks during a save do not send a second request', async () => {
  const h = harness();
  await h.render();
  const pending = deferred();
  h.api = () => pending.promise;
  h.controls.get('params.description').value = '正在保存';
  const first = h.triggerSave();
  const second = h.triggerSave();
  await second;
  assert.equal(h.requests.filter(([url, options]) => url === '/api/settings' && options?.method === 'PATCH').length, 1);
  pending.resolve({ changed: true, versions: { settings: 'vs2', schema: 'vc1', identity: 'vi1' }, menus: [] });
  await first;
});

test('settings: a 409 conflict keeps local input and does not merge server values', async () => {
  const h = harness();
  await h.render();
  h.api = async () => { throw new h.ApiError('conflict', { status: 409, code: 'SETTINGS_CHANGED', details: { currentVersion: 'vs9' } }); };
  h.controls.get('params.description').value = '本地未保存';
  await h.triggerSave();
  assert.equal(h.controls.get('params.description').value, '本地未保存', 'local input must survive a conflict');
  assert.match(h.notices.at(-1), /已在别处修改/);
  assert.match(h.$('save-settings').textContent, /有未提交修改/);
});

test('settings: a 428 (old client / missing version) is reported clearly', async () => {
  const h = harness();
  await h.render();
  h.api = async () => { throw new h.ApiError('missing version', { status: 428, code: 'SETTINGS_VERSION_REQUIRED' }); };
  h.controls.get('params.description').value = 'x';
  await h.triggerSave();
  assert.match(h.notices.at(-1), /缺少配置版本/);
});

test('settings: a schema with a locked field renders it disabled and skips it on save', async () => {
  const h = harness({ data: {
    schema: SCHEMA,
    values: { 'params.description': '旧', 'params.particles': 1 },
    menus: [],
    raw: 'RAW',
    versions: { settings: 'vs1', schema: 'vc1', identity: 'vi1' },
    fieldModes: { 'params.description': { editable: false, reason: 'multiline' } },
    menusMode: { editable: true },
    valid: true,
    syntaxError: null,
  } });
  await h.render();
  assert.equal(h.controls.get('params.description').disabled, true);
  h.controls.get('params.particles').value = '9';
  await h.triggerSave();
  const body = JSON.parse(h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PATCH')[1].body);
  assert.equal(Object.hasOwn(body.values, 'params.description'), false, 'locked field must not be submitted');
  assert.equal(body.values['params.particles'], 9);
});

test('settings: raw save sends baseVersion and skips when the text is unchanged', async () => {
  const h = harness();
  await h.render();
  await h.$('save-raw-settings').onclick();
  assert.equal(h.requests.filter(([url, options]) => url === '/api/settings' && options?.method === 'PUT').length, 0);
  assert.match(h.notices.at(-1), /原文没有变化/);

  h.$('raw-settings').value = 'RAW-TOML-2';
  await h.$('save-raw-settings').onclick();
  const put = h.requests.find(([url, options]) => url === '/api/settings' && options?.method === 'PUT');
  const body = JSON.parse(put[1].body);
  assert.equal(body.raw, 'RAW-TOML-2');
  assert.equal(body.baseVersion, 'vs1');
  assert.equal(body.schemaVersion, 'vc1');
  assert.equal(body.identityVersion, 'vi1');
});
