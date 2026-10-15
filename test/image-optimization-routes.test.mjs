import assert from 'node:assert/strict';
import test from 'node:test';

import { createImageOptimizationRoutes } from '../src/http/routes/image-optimization-routes.mjs';

function fixture({ body = '{}', serviceError } = {}) {
  const calls = [];
  const responses = [];
  const status = { supported: true, manifest: { validImages: 1, validCandidates: 2 }, task: { status: 'idle' } };
  const handler = createImageOptimizationRoutes({
    readBody: async (_req, limit) => { calls.push({ bodyLimit: limit }); return Buffer.from(body); },
    send: (_res, code, value) => responses.push({ code, value }),
    fail: (_res, code, message) => responses.push({ code, message }),
    imageOptimization: {
      snapshot: async () => status,
      start: async () => {
        calls.push({ start: true });
        if (serviceError) throw serviceError;
        return { ...status, task: { status: 'running' } };
      },
    },
  });
  return { handler, responses, calls };
}

test('optimization routes return read-only diagnostics and accept a bounded empty start request', async () => {
  const { handler, responses, calls } = fixture();
  const url = new URL('http://localhost/api/images/optimization');
  assert.equal(await handler({ method: 'GET' }, {}, url), true);
  assert.equal(responses[0].code, 200);
  assert.equal(responses[0].value.manifest.validCandidates, 2);
  assert.equal(calls.length, 0);
  assert.equal(await handler({ method: 'POST' }, {}, url), true);
  assert.equal(responses[1].code, 202);
  assert.equal(responses[1].value.task.status, 'running');
  assert.deepEqual(calls, [{ bodyLimit: 4096 }, { start: true }]);
  assert.equal(await handler({ method: 'DELETE' }, {}, url), false);
  assert.equal(await handler({ method: 'POST' }, {}, new URL('http://localhost/api/other')), false);
});

test('POST rejects command, path, mode, malformed JSON and query injection before starting', async () => {
  for (const body of ['{"command":"cmd"}', '{"path":"../secret"}', '{"responsive":false}', 'null', '[]', '{']) {
    const { handler, responses, calls } = fixture({ body });
    await handler({ method: 'POST' }, {}, new URL('http://localhost/api/images/optimization'));
    assert.equal(responses[0].code, 400);
    assert.equal(calls.some((call) => call.start), false);
  }
  const { handler, responses, calls } = fixture({ body: '' });
  await handler({ method: 'POST' }, {}, new URL('http://localhost/api/images/optimization?path=other'));
  assert.equal(responses[0].code, 400);
  assert.equal(calls.some((call) => call.start), false);
});

test('POST preserves unavailable and busy status codes', async () => {
  for (const statusCode of [409, 501]) {
    const { handler, responses } = fixture({ serviceError: Object.assign(new Error('unavailable'), { statusCode }) });
    await handler({ method: 'POST' }, {}, new URL('http://localhost/api/images/optimization'));
    assert.equal(responses[0].code, statusCode);
  }
});
