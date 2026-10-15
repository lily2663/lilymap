import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The production handlers run with controlled API promises and a minimal DOM.
// These fixtures never launch image jobs, upload files, or write blog data.
function harness(name) {
  const nodes = new Set();
  const ids = new Map();
  const timers = new Map();
  const requests = [];
  const notices = [];
  let timerId = 0;
  const state = { view: 'resources', posts: [] };
  function matches(node, selector) {
    if (selector.startsWith('#')) return node.attributes.id === selector.slice(1);
    const attribute = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    return !!attribute && Object.hasOwn(node.attributes, attribute[1])
      && (attribute[2] === undefined || node.attributes[attribute[1]] === attribute[2]);
  }
  function createNode(tag = 'div', attributes = {}, parent = null) {
    const node = {
      tag, attributes, parent, children: [], _connected: true, _html: '',
      disabled: Object.hasOwn(attributes, 'disabled'), hidden: Object.hasOwn(attributes, 'hidden'),
      value: attributes.value || (tag === 'select' ? 'all' : ''), textContent: '', files: [],
      dataset: Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])),
      get isConnected() { return this._connected && (!this.parent || this.parent.isConnected); },
      get innerHTML() { return this._html; },
      set innerHTML(html) {
        this._html = html;
        this.children.forEach((child) => { child._connected = false; });
        this.children = [];
        for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
          const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)]
            .map((entry) => [entry[1], entry[2] ?? '']));
          this.children.push(createNode(match[1], attrs, this));
        }
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) {
        return [...nodes].filter((candidate) => {
          for (let parent = candidate.parent; parent; parent = parent.parent) {
            if (parent === this) return candidate.isConnected && matches(candidate, selector);
          }
          return false;
        });
      },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener() {},
    };
    nodes.add(node);
    if (attributes.id) ids.set(attributes.id, node);
    return node;
  }
  const root = createNode('main', { id: 'main' });
  const fixture = {
    state, root, requests, notices, timers,
    api: async () => { throw Error('Unexpected API request'); },
    trackedFetch: async () => { throw Error('Unexpected upload'); },
    mountedOptimization: [],
    get: (selector) => root.querySelector(selector),
    async fireTimer() {
      const next = timers.entries().next().value;
      assert.ok(next, 'expected a scheduled status retry');
      timers.delete(next[0]);
      next[1]();
      await settle();
    },
    leave() { state.view = 'overview'; root.innerHTML = '<p>Another page</p>'; },
  };
  const source = fs.readFileSync(new URL(`../public/js/features/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
  const context = {
    state, $: (selector) => {
      const result = ids.get(selector.slice(1));
      return result?.isConnected ? result : null;
    },
    api: (...args) => { requests.push(args); return fixture.api(...args); },
    trackedFetch: (...args) => { requests.push(args); return fixture.trackedFetch(...args); },
    mountImageOptimization: (...args) => { fixture.mountedOptimization.push(args); },
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (value) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[value]),
    toast: (message) => notices.push(message),
    document: {
      querySelectorAll: (selector) => [...nodes].filter((node) => node.isConnected && matches(node, selector)),
      createElement: (tag) => createNode(tag),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { prompt: () => null }, confirm: () => false,
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const exported = name === 'resources' ? 'renderResources' : 'mountImageOptimization';
  vm.runInNewContext(`${source}\nglobalThis.feature = ${exported};`, context, { filename: name + '.js' });
  fixture.render = name === 'resources'
    ? () => context.feature({ page: () => '', bindCommon() {} })
    : () => context.feature(root, () => state.view === 'resources');
  return fixture;
}

function imageModel(status = 'idle') {
  return { supported: true, manifest: { validImages: 45, validCandidates: 89 }, task: { status, output: '' } };
}

test('image optimization: repeated activation starts one task and keeps the action disabled', async () => {
  const h = harness('image-optimization');
  const start = deferred();
  h.api = async (_, options) => options?.method === 'POST' ? start.promise : imageModel();
  await h.render();
  const action = h.get('[data-optimize]').onclick;
  const first = action();
  await action();
  assert.equal(h.requests.filter(([, options]) => options?.method === 'POST').length, 1);
  assert.equal(h.get('[data-optimize]').disabled, true);
  start.resolve(imageModel('running'));
  await first;
  assert.equal(h.get('[data-optimize]').disabled, true);
  assert.equal(h.timers.size, 1);
});

test('image optimization: a lost start response remains locked until status is confirmed', async () => {
  const h = harness('image-optimization');
  let statusCalls = 0;
  h.api = async (_, options) => {
    if (options?.method === 'POST') throw Error('Connection lost');
    return imageModel(++statusCalls === 1 ? 'idle' : 'running');
  };
  await h.render();
  await h.get('[data-optimize]').onclick();
  assert.equal(h.get('[data-optimize]').disabled, true);
  assert.match(h.root.innerHTML, /请勿重复启动/);
  await h.get('[data-optimize]').onclick();
  assert.equal(h.requests.filter(([, options]) => options?.method === 'POST').length, 1);
  await h.fireTimer();
  assert.equal(h.get('[data-optimize]').disabled, true);
  assert.match(h.root.innerHTML, /正在生成图片尺寸版本/);
});

test('image optimization: three failed progress reads stop polling without enabling another task', async () => {
  const h = harness('image-optimization');
  let offline = false;
  h.api = async () => { if (offline) throw Error('Offline'); return imageModel('running'); };
  await h.render();
  offline = true;
  for (let count = 0; count < 3; count++) await h.fireTimer();
  assert.equal(h.requests.length, 4);
  assert.equal(h.timers.size, 0);
  assert.equal(h.get('[data-optimize]').disabled, true);
  assert.match(h.root.innerHTML, /任务可能仍在继续/);
  h.api = async () => imageModel('success');
  h.get('[data-optimize-refresh]').onclick();
  await settle();
  assert.equal(h.get('[data-optimize]').disabled, false);
  assert.equal(h.timers.size, 0);
  assert.match(h.root.innerHTML, /响应式图片已更新/);
});

test('image optimization: a pending start or progress callback cannot redraw after leaving', async () => {
  for (const phase of ['start', 'progress']) {
    const h = harness('image-optimization');
    const pending = deferred();
    h.api = (_, options) => options?.method === 'POST' || phase === 'progress'
      ? pending.promise : Promise.resolve(imageModel());
    const request = phase === 'progress' ? h.render() : (await h.render(), h.get('[data-optimize]').onclick());
    h.leave();
    pending.resolve(imageModel('running'));
    await request;
    assert.equal(h.root.innerHTML, '<p>Another page</p>');
    assert.equal(h.timers.size, 0);
  }
});

test('image optimization: a refresh issued before starting cannot overwrite the new running task', async () => {
  const h = harness('image-optimization');
  const previousStatus = deferred();
  let reads = 0;
  h.api = (_, options) => options?.method === 'POST' ? Promise.resolve(imageModel('running'))
    : ++reads === 1 ? Promise.resolve(imageModel()) : previousStatus.promise;
  await h.render();
  h.get('[data-optimize-refresh]').onclick();
  await h.get('[data-optimize]').onclick();
  previousStatus.resolve(imageModel());
  await settle();
  assert.equal(h.get('[data-optimize]').disabled, true);
  assert.match(h.root.innerHTML, /正在生成图片尺寸版本/);
  assert.equal(h.timers.size, 1);
});

function resourceFile(index, extra = {}) {
  const filename = `photo-${String(index).padStart(2, '0')}.png`;
  return { path: `static/assets/img/${filename}`, publicPath: `/assets/img/${filename}`,
    scope: 'public', kind: 'image', extension: 'png', size: 1000, ...extra };
}
const cardCount = (h) => [...h.get('#resource-grid').innerHTML.matchAll(/class="asset-card"/g)].length;

test('resources: pagination shows 24 cards and search or scope resets the visible limit', async () => {
  const h = harness('resources');
  const files = Array.from({ length: 52 }, (_, index) => resourceFile(index));
  files.push(resourceFile(60, { path: 'content/posts/story/scene.png', publicPath: null, scope: 'content' }));
  h.state.posts = [{ kind: 'bundle', directory: 'content/posts/story', title: '旅行纪念' }];
  h.api = async () => ({ files });
  await h.render();
  assert.equal(cardCount(h), 24);
  assert.match(h.get('#resource-count').textContent, /共 53 个匹配资源，已显示 24 个/);
  h.get('#resource-more').onclick();
  assert.equal(cardCount(h), 48);
  h.get('#resource-more').onclick();
  assert.equal(cardCount(h), 53);
  assert.equal(h.get('#resource-more').hidden, true);
  const search = h.get('#resource-search');
  search.value = 'PHOTO-0';
  search.oninput();
  assert.equal(cardCount(h), 10);
  search.value = '';
  search.oninput();
  assert.equal(cardCount(h), 24);
  const scope = h.get('#resource-scope');
  scope.value = 'article';
  scope.onchange();
  assert.equal(cardCount(h), 1);
  assert.match(h.get('#resource-grid').innerHTML, /旅行纪念/);
  scope.value = 'all';
  scope.onchange();
  search.value = '旅行纪念';
  search.oninput();
  assert.equal(cardCount(h), 1);
  assert.match(h.get('#resource-grid').innerHTML, /scene\.png/);
});

test('resources: generated responsive images have no cards or mutation actions', async () => {
  const h = harness('resources');
  h.api = async () => ({ files: [resourceFile(1),
    resourceFile(2, { path: 'static/assets/img/responsive/derived-one.webp', publicPath: '/assets/img/responsive/derived-one.webp', generated: true }),
    resourceFile(3, { path: 'static/assets/img/responsive/derived-two.webp', publicPath: '/assets/img/responsive/derived-two.webp' }),
    resourceFile(4, { path: 'static/assets/img/derived-flag.webp', generated: true })] });
  await h.render();
  assert.equal(cardCount(h), 1);
  assert.match(h.root.innerHTML, /3 个自动生成的尺寸版本已收起/);
  assert.doesNotMatch(h.get('#resource-grid').innerHTML, /derived-/);
  assert.equal(h.root.querySelectorAll('[data-file-action]').length, 3);
});

test('resources: a pending list or upload completion cannot replace a page visited meanwhile', async () => {
  const h = harness('resources');
  const listed = deferred();
  h.api = () => listed.promise;
  const rendering = h.render();
  h.leave();
  listed.resolve({ files: [resourceFile(1)] });
  await rendering;
  assert.equal(h.root.innerHTML, '<p>Another page</p>');
  h.state.view = 'resources';
  h.api = async () => ({ files: [] });
  await h.render();
  const uploaded = deferred();
  h.trackedFetch = () => uploaded.promise;
  const input = h.get('#res-upload');
  input.files = [{ name: 'selected.png', type: 'image/png' }];
  const uploading = input.onchange();
  const before = h.requests.filter(([url]) => url === '/api/files').length;
  h.leave();
  uploaded.resolve({ ok: true });
  await uploading;
  assert.equal(h.requests.filter(([url]) => url === '/api/files').length, before);
  assert.equal(h.root.innerHTML, '<p>Another page</p>');
});

test('resources: multiple uploads run at most three requests at a time and finish all files', async () => {
  const h = harness('resources');
  h.api = async () => ({ files: [] });
  await h.render();
  let active = 0;
  let maximum = 0;
  const pending = [];
  h.trackedFetch = () => {
    active++;
    maximum = Math.max(maximum, active);
    const request = deferred();
    pending.push(request);
    return request.promise.finally(() => { active--; });
  };
  const input = h.get('#res-upload');
  input.files = Array.from({ length: 8 }, (_, index) => ({ name: `upload-${index}.png`, type: 'image/png' }));
  const uploading = input.onchange();
  assert.equal(pending.length, 3);
  assert.equal(input.disabled, true);
  for (let index = 0; index < 8; index++) {
    assert.ok(pending[index], `upload ${index} should have started`);
    if (index === 1) pending[index].reject(Error('Upload disconnected'));
    else pending[index].resolve({ ok: index !== 4 });
    await settle();
  }
  await uploading;
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.equal(pending.length, 8);
  assert.match(h.notices.at(-1), /成功 6 个，失败 2 个/);
  assert.equal(h.requests.filter(([url]) => url.startsWith('/api/asset/upload')).length, 8);
  assert.equal(h.get('#res-upload').disabled, false);
});
