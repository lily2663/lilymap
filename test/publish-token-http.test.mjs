import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('publish token endpoint validates input and never echoes the secret', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lilymap-publish-token-'));
  const theme = path.join(root, 'themes', 'fixture');
  const put = async (name, content) => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  let child;
  try {
    await put('hugo.toml', 'baseURL = "http://localhost/"\ntheme = "fixture"\n');
    await put('themes/fixture/theme-config.schema.json', '{"sections":[]}');
    const adminPort = await unusedPort();
    let blogPort = await unusedPort();
    while (blogPort === adminPort) blogPort = await unusedPort();
    child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--project', root, '--no-open'], {
      env: { ...process.env, ADMIN_PORT: String(adminPort), BLOG_PORT: String(blogPort), LILY_THEME_PATH: theme },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const base = `http://127.0.0.1:${adminPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${base}/api/publish/status`)).ok; } catch {}
      if (ready) break;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);

    const token = 'ghp_123456789012345678901234567890';
    const save = (value) => fetch(`${base}/api/publish/token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ token: value }),
    });
    const response = await save(token);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), new RegExp(token));
    assert.equal((await readFile(path.join(root, '.token'), 'utf8')).trim(), token);

    const invalid = await save('invalid-token');
    assert.equal(invalid.status, 400);
    assert.equal((await readFile(path.join(root, '.token'), 'utf8')).trim(), token);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    assert.ok(path.basename(root).startsWith('lilymap-publish-token-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
