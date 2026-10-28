import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// L2-01 的端到端契约：真实 server.mjs + 真实 PATCH /api/article。
// 不重写 API：复用已有的 patchFrontMatter 白名单，只验证"双描述分离"后
// 前端能拿到足够信息，并且保存一个字段不会连带改动另一个字段或正文。
//
// 每个用例都用临时博客目录，绝不触碰真实仓库的 content/ 或 hugo.toml。

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

const BODY = [
  '',
  '# 群友靶机 Demo',
  '',
  '从端口枚举开始，找到 phpinfo 泄露，再借助 Session Upload Progress 条件竞争拿到 webshell。',
  '',
  '```bash',
  'nmap -sV -p- 10.0.0.1',
  '```',
  '',
  '最后用 SUID 文件覆盖完成提权。',
  '',
].join('\n');

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

// 只取正文部分（第二个 --- 之后），用于断言"保存元数据不动正文"。
function bodyOf(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return match ? match[2] : raw;
}

async function startAdmin(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-l2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'content', 'posts'), { recursive: true });
  await fsp.mkdir(path.join(root, 'data'), { recursive: true });
  await fsp.mkdir(path.join(root, 'themes', 'lily-epitaph'), { recursive: true });
  await fsp.mkdir(path.join(root, 'public'), { recursive: true });
  await fsp.writeFile(path.join(root, 'hugo.toml'), 'theme = "lily-epitaph"\n[params]\nauthor = "L2"\n');
  await fsp.writeFile(path.join(root, 'data', 'site.yaml'), 'author: L2\navatar: ""\naboutTitle: About\nabout: []\nlinks: []\nfriends: []\n');
  await fsp.writeFile(path.join(root, 'themes', 'lily-epitaph', 'theme-config.schema.json'), '{"sections":[]}\n');
  await fsp.writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>L2</title>');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }

  const adminPort = await freePort();
  const blogPort = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [path.resolve('server.mjs'), '--project', root, '--no-open'], {
    cwd: path.resolve('.'),
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      ADMIN_PORT: String(adminPort),
      BLOG_PORT: String(blogPort),
      // 预览构建用 Node 顶替 Hugo：本用例只验证 API 契约，不跑真实构建。
      LILY_HUGO_PATH: process.execPath,
    },
  });
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const diagnostics = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  t.after(() => { if (child.exitCode == null) child.kill(); });

  const base = `http://127.0.0.1:${adminPort}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`LilyMap exited early: ${diagnostics()}`);
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { root, base, diagnostics, child };
}

const readPost = async (base, relative) => {
  const response = await fetch(`${base}/api/post?path=${encodeURIComponent(relative)}`);
  assert.equal(response.status, 200);
  return response.json();
};

const patchArticle = async (base, relative, changes, version) => {
  const response = await fetch(`${base}/api/article?path=${encodeURIComponent(relative)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ changes, version }),
  });
  return { status: response.status, json: await response.json() };
};

test('L2-01 http: articleRecord exposes explicit description, effectiveDescription and descriptionSource separately', { timeout: 30_000 }, async (t) => {
  const { base } = await startAdmin(t, {
    'content/posts/summary-only/index.md': `---\ntitle: "只有摘要"\ndate: 2024-01-01\nsummary: "卡片摘要原文"\n---\n${BODY}`,
    'content/posts/desc/index.md': `---\ntitle: "有描述"\ndate: 2024-01-02\ndescription: "显式搜索简介"\nsummary: "卡片摘要"\n---\n${BODY}`,
    'content/posts/auto/index.md': `---\ntitle: "自动回退"\ndate: 2024-01-03\nsummary: ""\n---\n${BODY}`,
    'content/posts/locked/index.md': `---\ntitle: "加密文章"\ndate: 2024-01-04\ndescription: "不该采用"\nsummary: "也不该采用"\nparams:\n  protected: true\n---\n加密正文\n`,
  });

  const summaryOnly = (await readPost(base, 'content/posts/summary-only/index.md')).article;
  assert.equal(summaryOnly.description, '', '显式 description 缺省必须是空字符串，不能回退成 summary');
  assert.equal(summaryOnly.summary, '卡片摘要原文');
  assert.equal(summaryOnly.effectiveDescription, '卡片摘要原文');
  assert.equal(summaryOnly.descriptionSource, 'summary');

  const explicit = (await readPost(base, 'content/posts/desc/index.md')).article;
  assert.equal(explicit.description, '显式搜索简介');
  assert.equal(explicit.summary, '卡片摘要');
  assert.equal(explicit.effectiveDescription, '显式搜索简介');
  assert.equal(explicit.descriptionSource, 'explicit-description');

  const auto = (await readPost(base, 'content/posts/auto/index.md')).article;
  assert.equal(auto.description, '');
  assert.equal(auto.summary, '');
  assert.equal(auto.descriptionSource, 'auto-body');
  assert.equal(auto.effectiveDescription, '群友靶机 Demo 从端口枚举开始，找到 phpinfo 泄露，再借助 Session Upload Progress 条件竞争拿到 webshell。 最后用 SUID 文件覆盖完成提权。');
  assert.equal(auto.descriptionBudgeted, false);

  const locked = (await readPost(base, 'content/posts/locked/index.md')).article;
  assert.equal(locked.protected, true);
  assert.equal(locked.effectiveDescription, '该文章已加密，需访问网站输入密码查看。');
  assert.equal(locked.descriptionSource, 'protected');
  assert.equal(locked.description, '不该采用', '受保护文章的显式值仍原样返回给编辑框，但不参与公开输出');
});

test('L2-01 http: saving only description leaves summary, body hash and unknown keys untouched', { timeout: 30_000 }, async (t) => {
  const original = `---\ntitle: "往返测试"\ndate: 2024-01-05\nlastmod: 2024-06-01\nslug: "round-trip"\nsummary: "保留这个摘要"\ntags:\n  - "靶机"\ncustomUnknownKey: "必须保留"\nparams:\n  protected: false\n  commentId: "round-trip"\ncover: ""\n---\n${BODY}`;
  const { root, base } = await startAdmin(t, { 'content/posts/round/index.md': original });
  const target = path.join(root, 'content', 'posts', 'round', 'index.md');

  const before = await readPost(base, 'content/posts/round/index.md');
  const bodyHashBefore = sha256(bodyOf(await fsp.readFile(target, 'utf8')));

  const saved = await patchArticle(base, 'content/posts/round/index.md', { description: '新的搜索简介' }, before.version);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.article.description, '新的搜索简介');
  assert.equal(saved.json.article.summary, '保留这个摘要', '只改 description 不能动 summary');
  assert.equal(saved.json.article.descriptionSource, 'explicit-description');
  // 未提交的字段必须保持原值
  assert.equal(saved.json.article.title, '往返测试');
  assert.equal(saved.json.article.date, '2024-01-05');
  assert.equal(saved.json.article.lastmod, '2024-06-01');
  assert.equal(saved.json.article.slug, 'round-trip');
  assert.deepEqual(saved.json.article.tags, ['靶机']);

  const after = await fsp.readFile(target, 'utf8');
  assert.equal(sha256(bodyOf(after)), bodyHashBefore, '正文哈希必须完全一致');
  assert.match(after, /customUnknownKey: "必须保留"/, '未知 front matter 字段必须原样保留');
  assert.match(after, /^summary: "保留这个摘要"$/m, '未变字段的行必须保持原样');

  // 反向：只改 summary，description 不动
  const latest = await readPost(base, 'content/posts/round/index.md');
  const second = await patchArticle(base, 'content/posts/round/index.md', { summary: '只改摘要' }, latest.version);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.article.description, '新的搜索简介', '只改 summary 不能动 description');
  assert.equal(second.json.article.summary, '只改摘要');
  assert.equal(second.json.article.descriptionSource, 'explicit-description');

  const finalRaw = await fsp.readFile(target, 'utf8');
  assert.equal(sha256(bodyOf(finalRaw)), bodyHashBefore, '两次保存后正文仍必须完全一致');
});

test('L2-01 http: clearing description falls back to summary, and clearing both falls back to body', { timeout: 30_000 }, async (t) => {
  const { base } = await startAdmin(t, {
    'content/posts/clear/index.md': `---\ntitle: "清空测试"\ndate: 2024-01-06\ndescription: "先有描述"\nsummary: "先有摘要"\n---\n${BODY}`,
  });
  const relative = 'content/posts/clear/index.md';
  const first = await readPost(base, relative);

  // 清空 description → 回退 summary
  const cleared = await patchArticle(base, relative, { description: '' }, first.version);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.article.description, '', '清空后 description 必须是空字符串，而不是残值');
  assert.equal(cleared.json.article.descriptionSource, 'summary');
  assert.equal(cleared.json.article.effectiveDescription, '先有摘要');
  assert.equal(cleared.json.article.summary, '先有摘要');

  // 再清空 summary → 回退正文
  const second = await readPost(base, relative);
  const bothCleared = await patchArticle(base, relative, { summary: '' }, second.version);
  assert.equal(bothCleared.status, 200, JSON.stringify(bothCleared.json));
  assert.equal(bothCleared.json.article.descriptionSource, 'auto-body');
  assert.match(bothCleared.json.article.effectiveDescription, /群友靶机 Demo/);
});

test('L2-01 http: a stale version returns 409 and writes nothing', { timeout: 30_000 }, async (t) => {
  const original = `---\ntitle: "冲突测试"\ndate: 2024-01-07\nsummary: "原始摘要"\n---\n${BODY}`;
  const { root, base } = await startAdmin(t, { 'content/posts/conflict/index.md': original });
  const relative = 'content/posts/conflict/index.md';
  const first = await readPost(base, relative);

  // 模拟另一个窗口先保存了一次，使本地持有的 version 过期
  const other = await patchArticle(base, relative, { summary: '别的窗口改写' }, first.version);
  assert.equal(other.status, 200);

  const stale = await patchArticle(base, relative, { description: '本地未保存的输入' }, first.version);
  assert.equal(stale.status, 409, '过期版本必须 409，不能静默覆盖');
  assert.ok(stale.json.error);

  const onDisk = await fsp.readFile(path.join(root, 'content', 'posts', 'conflict', 'index.md'), 'utf8');
  assert.doesNotMatch(onDisk, /本地未保存的输入/, '冲突时不得写入任何内容');
  assert.match(onDisk, /summary: "别的窗口改写"/, '别处的保存结果必须保留');
});

test('L2-01 http: protected article ignores an explicit description on save', { timeout: 30_000 }, async (t) => {
  const { base } = await startAdmin(t, {
    'content/posts/locked/index.md': `---\ntitle: "加密"\ndate: 2024-01-08\nsummary: "旧摘要"\nparams:\n  protected: true\n---\n加密正文\n`,
  });
  const relative = 'content/posts/locked/index.md';
  const first = await readPost(base, relative);
  const saved = await patchArticle(base, relative, { description: '受保护文章也填了描述' }, first.version);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.article.description, '受保护文章也填了描述', '显式值要保存下来，方便解密后再用');
  assert.equal(saved.json.article.effectiveDescription, '该文章已加密，需访问网站输入密码查看。', '受保护时公开描述必须是固定占位');
  assert.equal(saved.json.article.descriptionSource, 'protected');
});

test('L2-01 http: PATCH rejects a bare protected change and ignores unknown keys', { timeout: 30_000 }, async (t) => {
  const { root, base } = await startAdmin(t, {
    'content/posts/guard/index.md': `---\ntitle: "白名单"\ndate: 2024-01-09\nsummary: "摘要"\n---\n${BODY}`,
  });
  const relative = 'content/posts/guard/index.md';
  const first = await readPost(base, relative);

  const protectedAttempt = await patchArticle(base, relative, { protected: true }, first.version);
  assert.equal(protectedAttempt.status, 400, '单独修改保护标记必须被拒绝');

  const unknown = await patchArticle(base, relative, { nonsenseField: 'x', description: '合法字段' }, first.version);
  assert.equal(unknown.status, 200, JSON.stringify(unknown.json));
  const onDisk = await fsp.readFile(path.join(root, 'content', 'posts', 'guard', 'index.md'), 'utf8');
  assert.doesNotMatch(onDisk, /nonsenseField/, '不在白名单的键不能被写入文件');
  assert.match(onDisk, /description: "合法字段"/);
});
