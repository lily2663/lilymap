// EXE 产物清单与校验和（L0-02）
//
// 在 `npm run exe` 产出 dist/LilyMap.exe 之后运行，做三件事：
//   1. 计算 EXE 的 SHA-256 与字节数
//   2. 写 dist/LilyMap.manifest.json —— 记录"这个文件是什么"以及"它从哪来"
//   3. 写 dist/SHA256SUMS.txt —— 供人工/脚本校验
//
// ## 为什么需要"构建会话"标记
//
// 实测到的一个危险情况：直接对一个**已存在的旧 EXE** 运行本脚本时，
// 若把当前工作区的 Git SHA 写进 manifest，会造成严重误导——
// 读 manifest 的人会以为"这个 EXE 是从当前源码构建的"。
// 但旧 EXE 完全可能来自一个月前的一次打包，源码早已不同。
//
// 因此引入会话文件 `dist/.build-session.json`：
//   - 打包脚本在**开始打包前**写入会话（含开始时间戳）
//   - 本脚本读取会话，并要求 EXE 的 mtime **不早于**会话开始时间
//   - 不满足时（即 EXE 是别人留下的旧文件）：
//       provenance.known = false
//       provenance.reason 明确写"该产物早于本次构建会话，不是本次构建的产物"
//     并且**不写入** build 区块的 sourceSha 语义（改为 null），避免被误读。
//
// 这样 manifest 要么证明"本次构建的产物"，要么明确否认，不存在中间地带。
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { collectBuildInfo, publicBuildConstant } from './build-info.mjs';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(adminRoot, 'dist');
const exePath = path.join(distDir, 'LilyMap.exe');
const sessionPath = path.join(distDir, '.build-session.json');

let stats;
try {
  stats = await stat(exePath);
} catch {
  console.error(`找不到 ${path.relative(adminRoot, exePath)}，请先运行 npm run exe`);
  process.exit(1);
}

// ---- 会话核对 ----
let session = null;
try {
  session = JSON.parse(await readFile(sessionPath, 'utf8'));
} catch { /* 没有会话文件 → 说明未经本次打包 */ }

let producedInThisSession = false;
let sessionReason = '';
if (!session) {
  sessionReason = '缺少本次构建的会话标记（dist/.build-session.json），该产物可能是既有文件，来源未知';
} else {
  const startedMs = Date.parse(session.startedAt);
  const exeMs = stats.mtime.getTime();
  if (Number.isFinite(startedMs) && exeMs >= startedMs) {
    producedInThisSession = true;
  } else {
    sessionReason = `该产物写入时间（${stats.mtime.toISOString()}）早于本次构建会话开始时间（${session.startedAt}），不是本次构建的产物，来源未知`;
  }
}

const buf = await readFile(exePath);
const sha = createHash('sha256').update(buf).digest('hex');

const info = collectBuildInfo({ adminRoot, repoRoot: path.resolve(adminRoot, '..', '..') });
const constant = publicBuildConstant(info);

// bundle 的 manifest 若存在，一并记录，便于核对"EXE 是用哪个 bundle 打出来的"
let bundleRef = null;
try {
  const bundleManifest = JSON.parse(await readFile(path.join(distDir, 'build-manifest.json'), 'utf8'));
  bundleRef = {
    artifact: bundleManifest.artifact,
    artifactBytes: bundleManifest.artifactBytes,
    artifactSha256: bundleManifest.artifactSha256,
  };
} catch { /* 没有就保持 null，不编造 */ }

// 关键判定：只有"本次会话产出 + Git 可用 + 工作树干净"才算来源已证实
const provenance = producedInThisSession
  ? info.provenance
  : { known: false, reason: sessionReason };

await mkdir(distDir, { recursive: true });

const manifest = {
  schemaVersion: 1,
  product: 'LilyMap',
  artifact: 'LilyMap.exe',
  artifactBytes: buf.length,
  artifactSha256: sha,
  fileMtime: stats.mtime.toISOString(),
  // 明确声明：mtime 只说明写入时间，不是来源证据
  mtimeIsSourceEvidence: false,
  producedInThisSession,
  bundle: bundleRef,
  // 只有本次会话产出时才带上构建信息；否则置 null，杜绝"旧产物 + 新 SHA"的误读
  build: producedInThisSession ? constant : null,
  provenance,
  note: 'artifactSha256 证明文件身份（可校验未被篡改）。sourceSha 只在本机 Git 可用、'
    + '工作树干净、且产物由本次构建会话产出时才可信。文件时间不作为来源证据。',
};

const manifestPath = path.join(distDir, 'LilyMap.manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const sumsPath = path.join(distDir, 'SHA256SUMS.txt');
await writeFile(sumsPath, `${sha}  LilyMap.exe\n`, 'utf8');

console.log(`artifact: dist/LilyMap.exe (${buf.length} bytes)`);
console.log(`sha256: ${sha}`);
if (producedInThisSession) {
  console.log(`source: ${info.sourceSha === 'unknown' ? 'unknown' : info.sourceSha.slice(0, 12)} dirty=${info.dirty}`);
} else {
  console.log('source: 未知（该产物不是本次构建产生的）');
}
console.log(`provenance: ${provenance.known ? 'known' : 'unknown'} — ${provenance.reason}`);
console.log('manifest: dist/LilyMap.manifest.json');
console.log('sums:     dist/SHA256SUMS.txt');

// 会话文件用后即删：它只服务于一次打包，不该长期留在 dist 里干扰下次判定
if (session) await rm(sessionPath, { force: true });
