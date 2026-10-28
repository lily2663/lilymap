#!/usr/bin/env node
// L2-01 一致性验证：把 LilyMap 的 describeArticle() 与主题真实的
// seo/description.html 输出逐字比对。
//
// 为什么需要这个脚本：
//   "与主题保持一致"不能靠读代码声称，必须有真实 Hugo 构建做对照。
//   主题 partial 是唯一事实来源；LilyMap 只要 source 或 text 任一不同，
//   就说明两边语义漂移了。
//
// 用法（环境变量必须设置，否则报错退出而不静默跳过）：
//   LILY_TEST_HUGO_PATH=.../hugo.exe LILY_TEST_THEME_PATH=.../themes/lily-epitaph \
//   TMPDIR=... TEMP=... node tools/admin/scripts/verify-description-parity.mjs
//
// 退出码：0 = 全部一致；1 = 存在差异或环境缺失（绝不把缺失当通过）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeArticle } from '../src/domain/article-description.mjs';
import { parseFrontMatter } from '../src/domain/front-matter.mjs';

const hugo = process.env.LILY_TEST_HUGO_PATH;
const theme = process.env.LILY_TEST_THEME_PATH;

if (!hugo || !theme) {
  console.error('缺少 LILY_TEST_HUGO_PATH 或 LILY_TEST_THEME_PATH；本脚本不做静默跳过。');
  process.exit(1);
}
if (!fs.existsSync(hugo)) {
  console.error(`Hugo 不存在：${hugo}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(theme, 'theme.config.schema.json')) && !fs.existsSync(path.join(theme, 'theme-config.schema.json'))) {
  console.error(`主题目录无效（缺少 theme-config.schema.json）：${theme}`);
  process.exit(1);
}

// 场景矩阵：覆盖优先级每一级与受保护判定的两种写法。
const CASES = {
  'a-none': ['---\ntitle: "A"\ndate: 2024-01-01\nsummary: ""\n---\n只有正文，没有任何显式描述。这一段会被自动提取成描述文本。'],
  'b-summary': ['---\ntitle: "B"\ndate: 2024-01-02\nsummary: "只有摘要"\n---\n正文'],
  'c-desc': ['---\ntitle: "C"\ndate: 2024-01-03\ndescription: "只有描述"\n---\n正文'],
  'd-both': ['---\ntitle: "D"\ndate: 2024-01-04\ndescription: "描述优先"\nsummary: "摘要也该让路"\n---\n正文'],
  'e-prot': ['---\ntitle: "E"\ndate: 2024-01-05\ndescription: "不该用"\nsummary: "不该用"\nparams:\n  protected: true\n---\n加密'],
  'f-prot-bare': ['---\ntitle: "F"\ndate: 2024-01-06\nparams:\n  protected: true\n---\n加密'],
  'g-prot-top': ['---\ntitle: "G"\ndate: 2024-01-07\nprotected: true\n---\n加密'],
  'h-entity': ['---\ntitle: "H"\ndate: 2024-01-08\nsummary: ""\n---\n引用 A&amp;B 与 <code>x</code> 以及 &lt;script&gt; 示例。'],
  'i-inline': ['---\ntitle: "I"\ndate: 2024-01-09\nsummary: ""\n---\n行内 `nmap -sV` 保留文字，然后 &quot;引号&quot; 与 &nbsp;空格。'],
  'j-headings': ['---\ntitle: "J"\ndate: 2024-01-10\nsummary: ""\n---\n## 二级标题\n\n正文第一段。\n\n### 三级标题\n\n正文第二段，含**加粗**与[链接文字](https://example.com)。'],
  'k-code-table': ['---\ntitle: "K"\ndate: 2024-01-11\nsummary: ""\n---\n导语一段。\n\n```bash\nnmap -sV -p- 10.0.0.1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n结论段落。'],
  'l-crlf': null, // 在下方写成 CRLF，验证行尾不影响围栏剥离
  'm-prot-conflict': ['---\ntitle: "M"\ndate: 2024-01-13\nprotected: true\nparams:\n  protected: false\n---\n正文M'],
  'n-long': [`---\ntitle: "N"\ndate: 2024-01-14\nsummary: ""\n---\n${'长描述正文用于触发预算截断。'.repeat(30)}`],
};
CASES['l-crlf'] = ['---\ntitle: "L"\ndate: 2024-01-12\nsummary: ""\n---\n# SSRF\r\n\r\n```\r\ncd ~/Desktop/SSRF\r\ndocker-compose up -d\r\n```\r\n\r\nwindows环境：http://192.168.124.129:9091/\r\n'];

// Hugo 无法在本仓库之外创建输出目录（实测 mkdir Access is denied），
// 所以 fixture 必须建在博客仓库内的缓存目录里，而不是 os.tmpdir()。
// 优先级：LILY_PARITY_ROOT > <仓库>/.cache/tmp > os.tmpdir()。
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
function parityBase() {
  if (process.env.LILY_PARITY_ROOT) return process.env.LILY_PARITY_ROOT;
  const insideRepo = path.join(repoRoot, '.cache', 'tmp');
  try {
    fs.mkdirSync(insideRepo, { recursive: true });
    return insideRepo;
  } catch {
    return os.tmpdir();
  }
}

const root = fs.mkdtempSync(path.join(parityBase(), 'lilymap-l2-parity-'));
try {
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'layouts', '_default'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hugo.toml'), [
    'baseURL = "https://fixture.invalid/"',
    'title = "Parity"',
    'theme = "lily-epitaph"',
    'disableKinds = ["taxonomy", "term", "RSS", "sitemap", "robotsTXT", "404"]',
    '[params]',
    'description = ""',
    '[params.protected]',
    'enabled = true',
    '',
  ].join('\n'));
  // 直接调用主题的 partial，把 source 与 text 以 JSON 形式打印出来。
  fs.writeFileSync(path.join(root, 'layouts', '_default', 'single.html'),
    '{{- $r := partial "seo/description.html" . -}}{"source":"{{ $r.source }}","text":{{ $r.text | jsonify }}}');
  for (const [name, [content]] of Object.entries(CASES)) {
    fs.writeFileSync(path.join(root, 'content', 'posts', `${name}.md`), content);
  }

  const built = spawnSync(hugo, ['--source', root, '--themesDir', path.dirname(theme), '--theme', path.basename(theme), '--noBuildLock', '--quiet'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, HUGO_BUILD_NOJSCONFIGINASSETS: 'true' },
  });
  if (built.status !== 0) {
    console.error('Hugo 构建失败：\n', built.stdout, built.stderr);
    process.exit(1);
  }

  let pass = 0;
  const failures = [];
  for (const [name, [content]] of Object.entries(CASES)) {
    const publicFile = path.join(root, 'public', 'posts', name, 'index.html');
    if (!fs.existsSync(publicFile)) {
      failures.push({ name, reason: '主题没有为这个 fixture 产出页面' });
      continue;
    }
    const hugoResult = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
    const { frontMatter, body } = parseFrontMatter(content);
    const mine = describeArticle({ frontMatter, body });
    const same = mine.descriptionSource === hugoResult.source && mine.effectiveDescription === hugoResult.text;
    if (same) pass += 1;
    else failures.push({ name, hugo: hugoResult, mine: { source: mine.descriptionSource, text: mine.effectiveDescription } });
    console.log(`${same ? 'PASS' : 'DIFF'}  ${name.padEnd(18)} theme=${hugoResult.source.padEnd(21)} lilymap=${mine.descriptionSource}`);
  }

  console.log(`\n 合成 fixture 一致：${pass}/${Object.keys(CASES).length}`);

  // 真实文章对照：把 content/posts 下每篇都用主题 partial 跑一遍。
  // 真实语料才会暴露 CommonMark 的边界情况（例如中文右括号后的 ** 不构成强调）。
  const realPass = await compareRealPosts(root);
  console.log(` 真实文章一致：${realPass.pass}/${realPass.total || 0}`);

  if (failures.length) {
    console.error('\n合成 fixture 差异明细：');
    for (const failure of failures) console.error(' -', JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
  if (realPass.failures.length || realPass.total === 0) {
    console.error('\n真实文章差异明细：');
    for (const failure of realPass.failures) console.error(' -', JSON.stringify(failure, null, 2));
    if (realPass.total === 0) console.error(' - 没有找到任何真实文章，本项不能算通过。');
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// 复用同一个 fixture 站点重建一次（清空后放入真实文章），
// 逐篇比较 source + text。按 slug（或目录名）定位输出目录。
async function compareRealPosts(root) {
  const postsRoot = path.join(repoRoot, 'content', 'posts');
  if (!fs.existsSync(postsRoot)) return { pass: 0, total: 0, failures: [{ name: 'content/posts', reason: '目录不存在' }] };

  fs.rmSync(path.join(root, 'content', 'posts'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'public'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });

  const names = [];
  for (const directory of fs.readdirSync(postsRoot)) {
    const source = path.join(postsRoot, directory, 'index.md');
    if (!fs.existsSync(source)) continue;
    // 草稿默认不渲染，这里只把 draft 打开，不改任何其他字节。
    const raw = fs.readFileSync(source, 'utf8').replace(/^draft: true/m, 'draft: false');
    fs.mkdirSync(path.join(root, 'content', 'posts', directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'content', 'posts', directory, 'index.md'), raw);
    names.push(directory);
  }

  const built = spawnSync(hugo, ['--source', root, '--themesDir', path.dirname(theme), '--theme', path.basename(theme), '--noBuildLock', '--quiet'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, HUGO_BUILD_NOJSCONFIGINASSETS: 'true' },
  });
  if (built.status !== 0) return { pass: 0, total: names.length, failures: [{ name: 'hugo', reason: built.stderr || built.stdout }] };

  let pass = 0;
  const failures = [];
  for (const directory of names) {
    const raw = fs.readFileSync(path.join(root, 'content', 'posts', directory, 'index.md'), 'utf8');
    const { frontMatter, body } = parseFrontMatter(raw);
    const mine = describeArticle({ frontMatter, body });
    const slug = String(frontMatter.slug || directory).toLowerCase();
    const publicFile = path.join(root, 'public', 'posts', slug, 'index.html');
    if (!fs.existsSync(publicFile)) {
      failures.push({ name: directory, reason: `未找到 ${slug} 的渲染输出` });
      continue;
    }
    const hugoResult = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
    if (mine.descriptionSource === hugoResult.source && mine.effectiveDescription === hugoResult.text) pass += 1;
    else failures.push({ name: directory, hugo: hugoResult, mine: { source: mine.descriptionSource, text: mine.effectiveDescription } });
  }
  return { pass, total: names.length, failures };
}
