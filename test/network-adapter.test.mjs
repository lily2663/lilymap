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


test('safe metadata redirects revalidate every target and strip secrets across hosts', async () => {
  const calls = [];
  const adapter = createNetworkAdapter({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: { ...options.headers } });
      if (String(url).includes('music.163.com')) {
        return {
          status: 302,
          ok: false,
          url: String(url),
          headers: headers({ location: 'https://m801.music.126.net/file.mp3' }),
          body: null,
          redirected: false,
        };
      }
      return {
        status: 200,
        ok: true,
        url: String(url),
        headers: headers({ 'content-type': 'audio/mpeg' }),
        body: null,
        redirected: false,
      };
    },
  });

  const result = await adapter.requestMetadataFollowing('https://music.163.com/song', {
    allowedHosts: ['music.163.com'],
    allowHostname: (host) => /^[a-z0-9.-]+\.music\.126\.net$/.test(host),
    headers: { cookie: 'secret=1', accept: '*/*' },
  });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.cookie, 'secret=1');
  assert.equal(calls[1].headers.cookie, undefined);
  assert.equal(calls[1].headers.accept, '*/*');
});

test('safe metadata redirects refuse an unapproved target before making the second request', async () => {
  let calls = 0;
  const adapter = createNetworkAdapter({
    fetchImpl: async (url) => {
      calls += 1;
      return {
        status: 302,
        ok: false,
        url: String(url),
        headers: headers({ location: 'https://127.0.0.1/private' }),
        body: null,
        redirected: false,
      };
    },
  });

  await assert.rejects(
    () => adapter.requestMetadataFollowing('https://music.163.com/song', {
      allowedHosts: ['music.163.com'],
      allowHostname: (host) => host.endsWith('.music.126.net'),
    }),
    (error) => error.code === 'HOST_NOT_ALLOWED',
  );
  assert.equal(calls, 1);
});
