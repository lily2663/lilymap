// bundle 构建（L0-02）：替代 package.json 里原来的单行 esbuild 命令。
//
// 相比原命令，本脚本额外做：
//   1. 采集构建来源（Git SHA / dirty / lock 摘要 / 主题 pin / 工具版本）
//   2. 用 esbuild `define` 把来源对象注入 `__LILYMAP_BUILD__`
//   3. 产出 `dist/build-manifest.json`（含产物 SHA-256）
//
// 注入方式的关键实测结论：
//   - 不能用 `banner` 做桥接：banner 在文件首行执行，而 define 只替换
//     模块内部的标识符，banner 里的占位符不会被替换 → 启动即 ReferenceError。
//   - 必须把 `define` 的目标写成一个**可解析为对象字面量**的字符串，
//     供 src/domain/build-provenance.mjs 里 `typeof __LILYMAP_BUILD__` 检测。
//   - 源码模式没有该常量，`typeof` 返回 'undefined'，天然安全降级。
//
// 约束：不修改任何依赖版本；不把本机绝对路径注入产物。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

import { collectBuildInfo, publicBuildConstant } from './build-info.mjs';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(adminRoot, 'server.cjs');
const distDir = path.join(adminRoot, 'dist');

const info = collectBuildInfo({ adminRoot, repoRoot: path.resolve(adminRoot, '..', '..') });
const constant = publicBuildConstant(info);

const result = await esbuild.build({
  entryPoints: [path.join(adminRoot, 'server.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: outFile,
  define: {
    'import.meta.url': 'undefined',
    // 注入对象字面量。JSON.stringify 两次：一次得到 JSON 文本，
    // 一次把该文本变成本文件里的字符串字面量，交给 esbuild 内联。
    __LILYMAP_BUILD__: JSON.stringify(constant),
  },
  metafile: true,
  logLevel: 'info',
});

if (result.errors.length) {
  console.error('bundle 构建失败');
  process.exit(1);
}

// ---- 产物清单 ----
await mkdir(distDir, { recursive: true });
const bundle = await readFile(outFile);
const bytes = bundle.length;
const sha = createHash('sha256').update(bundle).digest('hex');

const manifest = {
  schemaVersion: 1,
  artifact: 'server.cjs',
  artifactBytes: bytes,
  artifactSha256: sha,
  build: constant,
};
const manifestPath = path.join(distDir, 'build-manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`bundle: ${path.relative(adminRoot, outFile)} (${bytes} bytes, sha256 ${sha.slice(0, 16)}…)`);
console.log(`source: ${info.sourceSha === 'unknown' ? 'unknown' : info.sourceSha.slice(0, 12)} dirty=${info.dirty}`);
console.log(`manifest: ${path.relative(adminRoot, manifestPath)}`);
console.log(`provenance: ${info.provenance.known ? 'known' : 'unknown'} — ${info.provenance.reason}`);
