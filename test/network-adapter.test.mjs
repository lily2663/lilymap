import assert from 'node:assert/strict';
import test from 'node:test';

import { createNetworkAdapter } from '../src/services/network-adapter.mjs';

function headers(values = {}) {
  return { get: (name) => values[String(name).toLowerCase()] ?? null };
}

function response({ status = 200, body = '', location = '' } = {}) {
  const chunks = body === null ? null : (async function* () { yield Buffer.from(body); })();
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://music.163.com/api',
    headers: headers({ 'content-length': body == null ? null : String(Buffer.byteLength(body)), location }),
    body: chunks,
    redirected: false,
  };
}

test('network adapter rejects unsafe schemes and hosts before fetch', async () => {
  let calls = 0;
  const adapter = createNetworkAdapter({ fetchImpl: async () => { calls += 1; return response(); } });
  await assert.rejects(
    () => adapter.requestText('http://music.163.com/api', { allowedHosts: ['music.163.com'] }),
    (error) => error.code === 'UNSAFE_PROTOCOL',
  );
  await assert.rejects(
    () => adapter.requestText('https://evil.example/api', { allowedHosts: ['music.163.com'] }),
    (error) => error.code === 'HOST_NOT_ALLOWED',
  );
  assert.equal(calls, 0);
});

test('network adapter enforces streamed body limits even without trusted content-length', async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    url: 'https://music.163.com/api',
    headers: headers(),
    body: (async function* () { yield Buffer.alloc(8); yield Buffer.alloc(8); })(),
    redirected: false,
  });
  const adapter = createNetworkAdapter({ fetchImpl });
  await assert.rejects(
    () => adapter.requestText('https://music.163.com/api', { allowedHosts: ['music.163.com'], maxBytes: 10 }),
    (error) => error.code === 'BODY_TOO_LARGE',
  );
});

test('network adapter parses bounded JSON and exposes manual redirects', async () => {
  let mode = 'json';
  const adapter = createNetworkAdapter({
    fetchImpl: async () => mode === 'json'
      ? response({ body: '{"ok":true}' })
      : response({ status: 302, body: '', location: 'https://evil.example/' }),
  });
  const parsed = await adapter.requestJson('https://music.163.com/api', { allowedHosts: ['music.163.com'] });
  assert.deepEqual(parsed.json, { ok: true });

  mode = 'redirect';
  const redirected = await adapter.requestText('https://music.163.com/api', { allowedHosts: ['music.163.com'] });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.location, 'https://evil.example/');
});
