// 根目录 LilyMap.exe 的清单（L0-02 收尾）
//
// 背景：博客根目录的 `LilyMap.exe` 是用户实际双击启动的入口，
// 而 `tools/admin/dist/LilyMap.exe` 是打包输出。两者必须是同一份文件，
// 否则会出现"我启动了 A，但改的是 B"的困惑。
//
// 本脚本做两件事：
//   1. 核对两份 EXE 的 SHA-256 是否一致（不一致就明确报错，不静默通过）
//   2. 在根目录写 `LilyMap.manifest.json` + `SHA256SUMS.txt`，
//      内容从 dist 的 manifest 派生，并额外记录"它是从 dist 复制来的"
//
// 诚实性：根 EXE 的来源 = dist EXE 的来源。若 dist manifest 声明来源未知，
// 根 manifest 也必须是未知，不得因为"现在源码看起来对"就升格为已知。
import { createHash } from 'node:crypto';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blogRoot = path.resolve(adminRoot, '..', '..');

const distExe = path.join(adminRoot, 'dist', 'LilyMap.exe');
const rootExe = path.join(blogRoot, 'LilyMap.exe');
const distManifestPath = path.join(adminRoot, 'dist', 'LilyMap.manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const distBuf = await readFile(distExe);
const rootBuf = await readFile(rootExe);
const distSha = sha256(distBuf);
const rootSha = sha256(rootBuf);

if (distSha !== rootSha) {
  console.error('根目录 LilyMap.exe 与 dist/LilyMap.exe 不一致，拒绝生成清单。');
  console.error(`  dist: ${distSha}`);
  console.error(`  root: ${rootSha}`);
  console.error('请先执行：cp tools/admin/dist/LilyMap.exe LilyMap.exe');
  process.exit(1);
}

let distManifest = null;
try {
  distManifest = JSON.parse(await readFile(distManifestPath, 'utf8'));
} catch {
  distManifest = null;
}

const rootStat = await stat(rootExe);
const now = new Date().toISOString();

const manifest = {
  schemaVersion: 1,
  product: 'LilyMap',
  artifact: 'LilyMap.exe',
  location: '博客根目录（用户实际启动位置）',
  artifactBytes: rootBuf.length,
  artifactSha256: rootSha,
  fileMtime: rootStat.mtime.toISOString(),
  mtimeIsSourceEvidence: false,
  identicalTo: 'tools/admin/dist/LilyMap.exe',
  copiedAt: now,
  // 从 dist manifest 原样继承来源判定，不自行升级可信度
  producedInThisSession: distManifest?.producedInThisSession ?? false,
  bundle: distManifest?.bundle ?? null,
  build: distManifest?.build ?? null,
  provenance: distManifest?.provenance ?? {
    known: false,
    reason: '缺少 dist 清单，无法确认该产物来源',
  },
  note: '该文件由 tools/admin/dist/LilyMap.exe 复制而来，来源判定与 dist 清单一致。'
    + 'artifactSha256 可用于核对文件未被替换；文件时间不作为来源证据。',
};

// 根目录产物已被 .gitignore 忽略，清单只作本地核对用
await writeFile(path.join(blogRoot, 'LilyMap.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(path.join(blogRoot, 'SHA256SUMS.txt'), `${rootSha}  LilyMap.exe\n`, 'utf8');

console.log(`root exe: ${rootBuf.length} bytes, sha256 ${rootSha.slice(0, 16)}…`);
console.log(`与 dist 一致: 是`);
console.log(`provenance: ${manifest.provenance.known ? 'known' : 'unknown'} — ${manifest.provenance.reason}`);
console.log('written: LilyMap.manifest.json, SHA256SUMS.txt（博客根目录）');
