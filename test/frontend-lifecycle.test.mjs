import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const settled = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Run the actual feature handlers with a small DOM fixture and controlled API timing.
// No requests, file writes, publish jobs, or real configuration changes are made.
function featureHarness(name, view = name) {
  const elements = new Map();
  const timers = [];
  const notices = [];
  const requests = [];
  const state = { view };
  const node = (id = '') => ({
    id, hidden: true, disabled: false, value: '', dataset: {}, style: {}, textContent: '',
    isConnected: true, attributes: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    closest() { return { querySelector: () => ({ insertAdjacentHTML: (_, html) => addNodes(html) }) }; },
  });
  function addNodes(html) {
    for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const item = node(match[1]);
      item.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
      elements.set(item.id, item);
    }
  }
  const main = node('main');
  let markup = '';
  Object.defineProperty(main, 'innerHTML', {
    get: () => markup,
    set: (value) => {
      for (const item of elements.values()) if (item !== main) item.isConnected = false;
      elements.clear();
      elements.set('main', main);
      markup = value;
      addNodes(value);
    },
  });
  elements.set('main', main);
  const fixture = {
    state, timers, notices, requests, elements, main,
    api: async () => { throw Error('Unexpected API request'); },
    render: null,
    async fireTimer() {
      assert.ok(timers.length, 'expected a scheduled poll retry');
      timers.shift()();
      await settled();
    },
  };
  const source = fs.readFileSync(new URL(`../public/js/features/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const exported = name === 'publish' ? 'renderPublish' : name === 'settings' ? 'renderSettings' : 'renderAppearance';
  const context = {
    state, $: (selector) => elements.get(selector.slice(1)) || null,
    api: (...args) => { requests.push(args); return fixture.api(...args); },
    document: { querySelectorAll: () => [], querySelector: () => null },
    esc: (value) => String(value ?? ''), toast: (message) => notices.push(message),
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    confirm: () => true,
  };
  vm.runInNewContext(`${source}\nglobalThis.renderFeature = ${exported};`, context, { filename: name + '.js' });
  fixture.render = () => context.renderFeature({ page: (_, __, actions = '') => actions, bindCommon() {}, refresh() {} });
  fixture.leave = (nextView = 'overview') => { state.view = nextView; main.innerHTML = '<p>Another page</p>'; };
  return fixture;
}

const publishStatus = (job = null) => ({
  tokenPresent: true, remoteOk: true, workflowPresent: true, changes: [],
  allowedRemote: 'https://github.com/example/blog.git', allowedBranch: 'main', branch: 'main',
  publishJob: job,
});
const runningJob = { id: 'job-1', status: 'running', progress: 35, stage: '正在推送' };
const settingsData = { schema: { sections: [] }, values: {}, menus: [], raw: '' };

for (const [name, view] of [['publish', 'publish'], ['settings', 'settings'], ['appearance', 'appearance']]) {
  test(`${name}: a pending initial response cannot replace a different page`, async () => {
    const h = featureHarness(name, view);
    const request = deferred();
    h.api = (url) => url === '/api/files' ? Promise.resolve({ files: [] }) : request.promise;
    const rendering = h.render();
    h.leave();
    request.resolve(name === 'publish' ? publishStatus() : settingsData);
    await rendering;
    assert.equal(h.main.innerHTML, '<p>Another page</p>');
    assert.equal(h.state.settings, undefined);
  });

  test(`${name}: the latest render wins when status requests finish out of order`, async () => {
    const h = featureHarness(name, view);
    const previous = deferred();
    let dataCalls = 0;
    const response = name === 'publish' ? publishStatus() : settingsData;
    h.api = (url) => url === '/api/files' ? Promise.resolve({ files: [] })
      : ++dataCalls === 1 ? previous.promise : Promise.resolve(response);
    const oldRender = h.render();
    await h.render();
    const mounted = name === 'publish' ? h.elements.get('pub-progress')
      : name === 'settings' ? h.elements.get('save-settings') : h.elements.get('appr-save');
    previous.resolve(response);
    await oldRender;
    const active = name === 'publish' ? h.elements.get('pub-progress')
      : name === 'settings' ? h.elements.get('save-settings') : h.elements.get('appr-save');
    assert.equal(active, mounted);
  });
}

test('publish: a late progress success or failure after leaving is ignored', async () => {
  for (const fail of [false, true]) {
    const h = featureHarness('publish');
    const progress = deferred();
    h.api = (url) => url === '/api/publish/status' ? Promise.resolve(publishStatus(runningJob)) : progress.promise;
    await h.render();
    h.leave();
    if (fail) progress.reject(Error('Disconnected'));
    else progress.resolve({ ...runningJob, status: 'complete', progress: 100 });
    await settled();
    assert.equal(h.main.innerHTML, '<p>Another page</p>');
    assert.deepEqual(h.notices, []);
    assert.equal(h.timers.length, 0);
  }
});

test('publish: a refreshed page is not updated by an older polling response', async () => {
  const h = featureHarness('publish');
  const oldProgress = deferred();
  let statusCalls = 0;
  h.api = (url) => {
    if (url === '/api/publish/status') return Promise.resolve(publishStatus(++statusCalls === 1 ? runningJob : null));
    return oldProgress.promise;
  };
  await h.render();
  await h.elements.get('pub-refresh').onclick();
  const progress = h.elements.get('pub-progress');
  oldProgress.resolve({ ...runningJob, status: 'complete', progress: 100 });
  await settled();
  assert.equal(progress.hidden, true);
  assert.deepEqual(h.notices, []);
  assert.equal(h.timers.length, 0);
});

test('publish: losing progress connection retries without enabling a duplicate publish', async () => {
  const h = featureHarness('publish');
  h.api = async (url) => {
    if (url === '/api/publish/status') return publishStatus(runningJob);
    throw Error('Disconnected');
  };
  await h.render();
  await settled();
  await h.fireTimer();
  await h.fireTimer();
  assert.equal(h.requests.filter(([url]) => url.startsWith('/api/publish/progress')).length, 3);
  assert.equal(h.elements.get('pub-go').disabled, true);
  assert.equal(h.elements.get('pub-force').disabled, true);
  assert.match(h.elements.get('pub-stage').textContent, /进度暂不可用/);
  assert.match(h.elements.get('pub-detail').textContent, /可能仍在后台继续/);
  await h.elements.get('pub-go').onclick();
  assert.equal(h.requests.filter(([url]) => url === '/api/publish').length, 0);
  assert.equal(h.timers.length, 0);
});

test('publish: an error refreshing status leaves the mounted polling loop usable', async () => {
  const h = featureHarness('publish');
  const progress = deferred();
  let statusCalls = 0;
  h.api = (url) => {
    if (url === '/api/publish/status') return ++statusCalls === 1
      ? Promise.resolve(publishStatus(runningJob)) : Promise.reject(Error('Status unavailable'));
    return progress.promise;
  };
  await h.render();
  await h.elements.get('pub-refresh').onclick();
  progress.resolve({ ...runningJob, status: 'complete', progress: 100 });
  await settled();
  assert.equal(h.elements.get('pub-go').disabled, false);
  assert.equal(h.elements.get('pub-percent').textContent, '100%');
  assert.equal(h.elements.get('pub-refresh').disabled, false);
});

test('publish: the start request cannot overwrite a page visited while it was pending', async () => {
  const h = featureHarness('publish');
  const start = deferred();
  h.api = (url) => url === '/api/publish/status' ? Promise.resolve(publishStatus()) : start.promise;
  await h.render();
  const starting = h.elements.get('pub-go').onclick();
  const duplicate = h.elements.get('pub-go').onclick();
  await duplicate;
  assert.equal(h.requests.filter(([url]) => url === '/api/publish').length, 1);
  h.leave();
  start.resolve(runningJob);
  await starting;
  assert.equal(h.requests.filter(([url]) => url.startsWith('/api/publish/progress')).length, 0);
  assert.equal(h.main.innerHTML, '<p>Another page</p>');
});

test('publish: a lost start response stays locked until a status refresh confirms the running job', async () => {
  const h = featureHarness('publish');
  const progress = deferred();
  let statusCalls = 0;
  h.api = (url) => {
    if (url === '/api/publish/status') return Promise.resolve(publishStatus(++statusCalls === 1 ? null : runningJob));
    if (url === '/api/publish') return Promise.reject(Error('Start response disconnected'));
    if (url.startsWith('/api/publish/progress')) return progress.promise;
    throw Error('Unexpected request');
  };
  await h.render();
  await h.elements.get('pub-go').onclick();
  assert.equal(h.elements.get('pub-go').disabled, true);
  assert.equal(h.elements.get('pub-force').disabled, true);
  assert.equal(h.elements.get('pub-msg').disabled, true);
  assert.match(h.elements.get('pub-stage').textContent, /启动结果未确认/);
  assert.match(h.elements.get('pub-detail').textContent, /可能仍在后台继续/);
  assert.doesNotMatch(h.notices.at(-1), /发布失败/);
  await h.elements.get('pub-go').onclick();
  await h.elements.get('pub-force').onclick();
  assert.equal(h.requests.filter(([url]) => url === '/api/publish').length, 1);
  assert.equal(h.timers.length, 0);
  await h.elements.get('pub-refresh').onclick();
  assert.equal(h.elements.get('pub-go').disabled, true);
  assert.equal(statusCalls, 2);
  assert.equal(h.requests.filter(([url]) => url.startsWith('/api/publish/progress')).length, 1);
  progress.resolve({ ...runningJob, status: 'complete', progress: 100 });
  await settled();
  assert.equal(h.elements.get('pub-go').disabled, false);
  assert.equal(h.elements.get('pub-percent').textContent, '100%');
  assert.equal(h.requests.filter(([url]) => url === '/api/publish').length, 1);
});

test('appearance: a save completing after navigation does not mutate a later editor', async () => {
  const h = featureHarness('appearance');
  const save = deferred();
  h.api = (url, options) => options?.method === 'PATCH' ? save.promise
    : Promise.resolve(url === '/api/files' ? { files: [] } : settingsData);
  await h.render();
  const saving = h.elements.get('appr-save').onclick();
  h.leave('appearance');
  await h.render();
  const appearance = h.state.appr;
  appearance.dirty = true;
  const button = h.elements.get('appr-save');
  save.resolve({ ok: true });
  await saving;
  assert.equal(appearance.dirty, true);
  assert.equal(button.textContent, '');
  assert.equal(h.timers.length, 0);
});

test('appearance: selections made while saving remain dirty and duplicate saves are blocked', async () => {
  const h = featureHarness('appearance');
  const save = deferred();
  h.api = (url, options) => options?.method === 'PATCH' ? save.promise
    : Promise.resolve(url === '/api/files' ? { files: [] } : settingsData);
  await h.render();
  const button = h.elements.get('appr-save');
  const saving = button.onclick();
  await button.onclick();
  h.state.appr.curW = '/new-wallpaper.webp';
  save.resolve({ ok: true });
  await saving;
  assert.equal(h.requests.filter(([, options]) => options?.method === 'PATCH').length, 1);
  assert.equal(h.state.appr.dirty, true);
  assert.match(button.textContent, /有修改/);
  await h.fireTimer();
  assert.match(button.textContent, /有修改/);
  assert.equal(button.disabled, false);
});
