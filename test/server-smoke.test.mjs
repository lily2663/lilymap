import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, child, diagnostics, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`LilyMap exited early: ${diagnostics()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for LilyMap: ${diagnostics()}`);
}

test('LilyMap boots against a minimal Hugo project and serves core admin APIs', { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await fsp.mkdir(path.join(root, 'content', 'posts', 'hello'), { recursive: true });
  await fsp.mkdir(path.join(root, 'data'), { recursive: true });
  await fsp.mkdir(path.join(root, 'themes', 'lily-epitaph'), { recursive: true });
  await fsp.mkdir(path.join(root, 'public'), { recursive: true });

  await fsp.writeFile(path.join(root, 'hugo.toml'), 'theme = "lily-epitaph"\n[params]\nauthor = "Smoke"\n');
  await fsp.writeFile(path.join(root, 'data', 'site.yaml'), 'author: Smoke\navatar: ""\naboutTitle: About\nabout: []\nlinks: []\nfriends: []\n');
  await fsp.writeFile(path.join(root, 'themes', 'lily-epitaph', 'theme-config.schema.json'), '{"sections":[]}\n');
  await fsp.writeFile(path.join(root, 'content', 'posts', 'hello', 'index.md'), '---\ntitle: Hello\ndraft: false\n---\nSmoke body\n');
  await fsp.writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>Smoke Preview</title>');

  const adminPort = await freePort();
  const blogPort = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [
    path.resolve('server.mjs'),
    '--project', root,
    '--no-open',
  ], {
    cwd: path.resolve('.'),
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      ADMIN_PORT: String(adminPort),
      BLOG_PORT: String(blogPort),
      // The smoke test only verifies server/API wiring. Use Node as a harmless
      // executable so the scheduled preview build cannot depend on local Hugo.
      LILY_HUGO_PATH: process.execPath,
    },
  });
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const diagnostics = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  t.after(() => {
    if (child.exitCode == null) child.kill();
  });

  const base = `http://127.0.0.1:${adminPort}`;
  const index = await waitFor(`${base}/`, child, diagnostics);
  assert.match(await index.text(), /LilyMap|Lily|DOCTYPE|html/i);

  const settings = await fetch(`${base}/api/settings`);
  assert.equal(settings.status, 200, diagnostics());
  const settingsJson = await settings.json();
  assert.equal(settingsJson.values['params.author'], 'Smoke');
  assert.deepEqual(settingsJson.schema.sections, []);

  const profile = await fetch(`${base}/api/profile`);
  assert.equal(profile.status, 200, diagnostics());
  assert.equal((await profile.json()).profile.author, 'Smoke');

  const posts = await fetch(`${base}/api/posts`);
  assert.equal(posts.status, 200, diagnostics());
  const postJson = await posts.json();
  assert.equal(postJson.posts.length, 1);
  assert.equal(postJson.posts[0].title, 'Hello');

  const preview = await fetch(`http://127.0.0.1:${blogPort}/`);
  assert.equal(preview.status, 200, diagnostics());
  assert.match(await preview.text(), /Smoke Preview/);
});
