// 构建来源采集（L0-02）
//
// 目的：让每个产出的 bundle / EXE 都能回答"我是从哪个源码构建的"。
//
// 设计原则（来自执行说明书 03.2 / 2.6）：
//   1. 只记录**这次构建实际能取到的**事实。取不到就写 unknown，绝不猜测。
//   2. `sourceSha` 只在本机 Git 可用且工作树干净时才是可信值；
//      工作树有改动时写 dirty + 补丁摘要，不谎称是某个提交。
//   3. 不把绝对机器路径写进可发布包（构建现场路径只进本地 manifest）。
//   4. 不顺手升级任何依赖。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 判断 cwd 是否**自身**就是一个 Git 工作树根。
 *
 * 为什么需要：`git -C <dir> rev-parse` 会向上递归查找父仓库。
 * 若把工具目录复制到别处（或指向一个嵌套在别的仓库里的临时目录），
 * 会错误地返回**父仓库**的 HEAD，把来源诊断变成假信息。
 * 这里要求 `--show-toplevel` 与 cwd 相同，否则视为"无可用 Git 信息"。
 */
function isOwnWorktree(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return false;
  const normalize = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  // git 返回的是 POSIX 风格路径
  return normalize(top) === normalize(cwd);
}

/**
 * 采集当前工作区的构建来源信息。
 * @param {{ adminRoot: string, repoRoot?: string }} options
 * @returns {object} 构建信息；无法确定时对应字段为 'unknown'
 */
export function collectBuildInfo({ adminRoot, repoRoot = null }) {
  const pkgPath = path.join(adminRoot, 'package.json');
  const lockPath = path.join(adminRoot, 'package-lock.json');
  const pinPath = path.join(adminRoot, '.github', 'theme-compatibility.json');

  const metadata = JSON.parse(readFileSync(pkgPath, 'utf8'));

  // ---- Git 来源（只认"实际取到"的值）----
  // 必须确认 adminRoot 自身就是工作树根，否则 git 会向上找到父仓库，
  // 把父仓库的 HEAD 当成自己的来源（这是实测到的真实误判）。
  const ownsWorktree = isOwnWorktree(adminRoot);
  const head = ownsWorktree ? git(adminRoot, ['rev-parse', 'HEAD']) : null;
  const branch = ownsWorktree ? git(adminRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  const statusRaw = ownsWorktree ? git(adminRoot, ['status', '--porcelain']) : null;

  // git 不可用（便携环境 / 非独立仓库）时，一切来源字段都是 unknown
  const gitAvailable = Boolean(head);
  const dirty = gitAvailable ? Boolean(statusRaw && statusRaw.length > 0) : null;

  // 工作树有改动时，记录改动摘要，便于人工复现这次构建的源码状态
  let worktreeDiffSha = null;
  if (gitAvailable && dirty) {
    try {
      const diff = execFileSync('git', ['-C', adminRoot, 'diff', 'HEAD', '--binary'], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      worktreeDiffSha = sha256(diff);
    } catch {
      worktreeDiffSha = null;
    }
  }

  // ---- 依赖与兼容性 ----
  let lockSha = 'unknown';
  if (existsSync(lockPath)) lockSha = sha256(readFileSync(lockPath));

  let themePin = 'unknown';
  if (existsSync(pinPath)) {
    try {
      const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
      themePin = pin.ref || 'unknown';
    } catch {
      themePin = 'unknown';
    }
  }

  // ---- 工具版本 ----
  let esbuildVersion = 'unknown';
  try {
    esbuildVersion = JSON.parse(readFileSync(path.join(adminRoot, 'node_modules/esbuild/package.json'), 'utf8')).version;
  } catch { /* 保持 unknown */ }
  let pkgVersion = 'unknown';
  try {
    pkgVersion = JSON.parse(readFileSync(path.join(adminRoot, 'node_modules/@yao-pkg/pkg/package.json'), 'utf8')).version;
  } catch { /* 保持 unknown */ }

  const info = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    appVersion: metadata.version,
    sourceSha: gitAvailable ? head : 'unknown',
    sourceBranch: gitAvailable ? branch : 'unknown',
    dirty: dirty === null ? 'unknown' : dirty,
    worktreeDiffSha256: worktreeDiffSha || 'unknown',
    lockSha256: lockSha,
    themePin,
    nodeVersion: process.version,
    esbuildVersion,
    pkgVersion,
    // 本地构建现场路径：只进本地 manifest，不进可发布包
    buildHost: {
      adminRoot: adminRoot.split(path.sep).join('/'),
      repoRoot: repoRoot ? repoRoot.split(path.sep).join('/') : 'unknown',
      platform: process.platform,
      arch: process.arch,
    },
  };

  // 来源可信度判定：只有"Git 可用 + 工作树干净 + 取到 SHA"才算已证实
  info.provenance = gitAvailable && dirty === false
    ? { known: true, reason: `构建于干净的源码提交 ${head.slice(0, 12)}` }
    : gitAvailable
      ? { known: false, reason: `工作树有未提交改动（diff sha256 ${String(worktreeDiffSha).slice(0, 12)}），来源需连同补丁摘要核对` }
      : { known: false, reason: '本机无可用 Git 信息，无法证明源码来源' };

  return info;
}

/**
 * 生成要注入 bundle 的"可发布"构建常量。
 * 刻意剔除本机绝对路径，避免把机器信息带进分发产物。
 */
export function publicBuildConstant(info) {
  return {
    schemaVersion: info.schemaVersion,
    builtAt: info.builtAt,
    appVersion: info.appVersion,
    sourceSha: info.sourceSha,
    sourceBranch: info.sourceBranch,
    dirty: info.dirty,
    worktreeDiffSha256: info.worktreeDiffSha256,
    lockSha256: info.lockSha256,
    themePin: info.themePin,
    nodeVersion: info.nodeVersion,
    esbuildVersion: info.esbuildVersion,
    pkgVersion: info.pkgVersion,
    provenance: info.provenance,
  };
}
