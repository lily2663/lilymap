// 运行来源诊断（L0-01 / LM-01）
//
// 目的：让 /api/status 能如实回答“当前进程跑的到底是哪份代码”。
//
// 诚实性规则（执行说明书 2.6 / 03.2）：
//   1. “工作区源码状态”（workspaceSource）与“产物内嵌构建信息”
//      （embeddedBuildInfo）是两个不同的事实，必须分开呈现；
//      任何时候都不许用前者去填补后者，反之亦然。
//   2. 旧 bundle / EXE 没有嵌入源码 SHA 时，provenance.known 必须为 false，
//      并写明“文件时间不作为来源证据”；绝不能把当前 HEAD 反填成它的构建来源。
//   3. 没有真实构建结果时 lastBuild 为 null，不编造 ok/finishedAt。
//   4. 只输出低敏感诊断字段：不含 Token / Cookie / 环境变量 / 受保护正文。
//
// 本模块只做“读取与判定”，不采集 Git 本身（Git 命令由 server.mjs 注入），
// 这样判定逻辑可以在没有仓库的测试环境里独立验证。
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const UNKNOWN = 'unknown';

// 单条构建错误最多保留的字符数：Hugo 的报错可能很长，但诊断区只需要结论。
const MAX_BUILD_ERROR_CHARS = 400;

// 允许出现在 /api/status 里的内嵌构建字段白名单。
// 用白名单而不是整体透传：即使未来有人在构建常量里塞了 buildHost 之类的
// 机器信息，也不会经由诊断接口泄漏出去。
const EMBEDDED_FIELDS = [
  'schemaVersion',
  'builtAt',
  'appVersion',
  'sourceSha',
  'sourceBranch',
  'dirty',
  'worktreeDiffSha256',
  'lockSha256',
  'themePin',
  'nodeVersion',
  'esbuildVersion',
  'pkgVersion',
];

/**
 * 判定运行入口形态。
 *
 * - packed=true 是 pkg 打包后的 EXE（process.pkg 存在）；
 * - 没有 pkg 但存在 esbuild 注入的构建常量，说明跑的是 server.cjs bundle；
 * - 两者都没有且明确知道“不是打包态”，才是源码模式；
 * - 传入的 packed 不是布尔值时无法判定，返回 unknown 而不是猜 source。
 */
export function detectRuntimeMode({ packed = false, embeddedBuildInfo = null } = {}) {
  if (packed === true) return 'exe';
  if (embeddedBuildInfo && typeof embeddedBuildInfo === 'object') return 'bundle';
  if (packed === false) return 'source';
  return UNKNOWN;
}

/** 运行入口的展示名（不含本机绝对路径）。 */
export function describeEntrypoint({ mode, executablePath = '' } = {}) {
  if (mode === 'exe') {
    const name = executablePath ? path.basename(String(executablePath)) : '';
    return name || 'LilyMap.exe';
  }
  if (mode === 'bundle') return 'server.cjs';
  if (mode === 'source') return 'server.mjs';
  return UNKNOWN;
}

/** 只保留白名单字段；provenance 单独清洗，避免把任意对象写进接口。 */
export function sanitizeEmbeddedBuildInfo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clean = {};
  for (const key of EMBEDDED_FIELDS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) clean[key] = value;
  }
  const provenance = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : null;
  if (provenance) {
    clean.provenance = {
      known: provenance.known === true,
      reason: typeof provenance.reason === 'string' ? provenance.reason.slice(0, 500) : '',
    };
  }
  // 一个字段都没取到时不返回空对象，避免 UI 误以为“有内嵌信息”。
  return Object.keys(clean).length ? clean : null;
}

/**
 * 判定“来源是否已证实”，并给出人可读的原因。
 *
 * 注意 workspaceSource 只在源码模式下参与判定：源码模式下运行的代码就是
 * 工作区里的文件，所以工作区状态能直接说明来源；打包模式下工作区状态与
 * 产物来源无关，必须忽略它。
 */
export function resolveProvenance({ mode = UNKNOWN, embeddedBuildInfo = null, workspaceSource = null } = {}) {
  if (embeddedBuildInfo && typeof embeddedBuildInfo === 'object') {
    const declared = embeddedBuildInfo.provenance;
    const known = declared?.known === true;
    const reason = typeof declared?.reason === 'string' && declared.reason
      ? declared.reason
      : known
        ? `产物内嵌了构建来源（源码 ${String(embeddedBuildInfo.sourceSha || UNKNOWN).slice(0, 12)}）。`
        : '产物内嵌了构建信息，但该信息自身未标记为可证实来源。';
    return { known, reason };
  }

  if (mode === 'exe' || mode === 'bundle') {
    return {
      known: false,
      reason: `当前运行的是打包产物（${mode}），但产物未嵌入源码 SHA。无法证明它由哪次提交构建；不能把工作区 HEAD 当作它的来源，文件时间也不作为来源证据。`,
    };
  }

  if (mode === UNKNOWN) {
    return { known: false, reason: '无法判定当前运行入口形态，来源不可证实；文件时间不作为来源证据。' };
  }

  const head = workspaceSource && typeof workspaceSource.head === 'string' ? workspaceSource.head : UNKNOWN;
  if (head === UNKNOWN) {
    return {
      known: false,
      reason: '源码模式直接运行工作区代码，但本机 Git 不可用，无法证明对应的源码提交；文件时间不作为来源证据。',
    };
  }
  const dirty = workspaceSource?.dirty;
  const dirtyNote = dirty === true
    ? '工作区有未提交改动，运行的代码等于当前工作区内容而非 HEAD 快照'
    : dirty === false
      ? '工作区干净'
      : '工作区改动状态未知';
  return {
    known: true,
    reason: `源码模式：直接运行工作区代码（HEAD ${head.slice(0, 12)}，${dirtyNote}）；没有打包产物，不存在产物与源码不一致的问题。`,
  };
}

/** 归一化工作区状态；任何取不到的值都写 unknown，不猜测。 */
export function describeWorkspaceSource({ head, branch, dirty, scope = 'lilymap-admin' } = {}) {
  const cleanHead = typeof head === 'string' && head.trim() ? head.trim() : UNKNOWN;
  const cleanBranch = typeof branch === 'string' && branch.trim() ? branch.trim() : UNKNOWN;
  const cleanDirty = dirty === true || dirty === false ? dirty : UNKNOWN;
  return {
    scope,
    head: cleanHead,
    branch: cleanBranch,
    dirty: cleanDirty,
    available: cleanHead !== UNKNOWN,
  };
}

function buildErrorText(output) {
  const text = String(output || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!text) return '构建失败，但未捕获到 Hugo 输出。';
  return text.length <= MAX_BUILD_ERROR_CHARS ? text : `…${text.slice(-MAX_BUILD_ERROR_CHARS)}`;
}

/**
 * 把 build-service 的 snapshot() 映射成 lastBuild。
 * 没有完成过构建时返回 null（不编造 ok=false + 时间）。
 */
export function describeLastBuild(build) {
  if (!build || typeof build !== 'object') return null;
  const status = typeof build.status === 'string' ? build.status : '';
  const finishedAt = typeof build.finishedAt === 'string' && build.finishedAt ? build.finishedAt : null;
  if (!finishedAt) return null;
  const ok = status === 'success' || (status === '' && Number(build.code) === 0);
  return { ok, finishedAt, error: ok ? null : buildErrorText(build.output) };
}

/** 主题 schema 的短摘要：用于判断“运行时读到的主题契约”是不是同一份。 */
export function hashSchema(buffer) {
  if (!buffer) return null;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  if (!bytes.length) return null;
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function createRuntimeInfoService({
  repoRoot,
  adminRoot,
  themeRoot,
  themeName,
  publicDir,
  getPort = () => 0,
  readAppVersion = () => UNKNOWN,
  readEmbeddedBuildInfo = () => null,
  readWorkspaceSource = async () => ({}),
  readBuildSnapshot = () => null,
  packed = false,
  executablePath = process.execPath,
  nodeVersion = process.version,
} = {}) {
  // 构建服务在“正在构建”时会清空 finishedAt；这里记住最近一次完成的结果，
  // 让诊断区在重建期间仍能看到上一次的真实结论。
  let lastCompleted = null;

  async function themeSnapshot() {
    const compatiblePath = path.join(String(themeRoot || ''), 'theme-config.schema.json');
    let compatible = false;
    let schemaHash = null;
    try {
      const buffer = await fs.readFile(compatiblePath);
      compatible = true;
      schemaHash = hashSchema(buffer);
    } catch {
      compatible = false;
      schemaHash = null;
    }
    const relative = repoRoot && themeRoot ? path.relative(repoRoot, themeRoot).split(path.sep).join('/') : '';
    return {
      name: themeName || UNKNOWN,
      path: relative || UNKNOWN,
      compatible,
      schemaHash,
    };
  }

  async function snapshot() {
    const embedded = sanitizeEmbeddedBuildInfo(readEmbeddedBuildInfo());
    const mode = detectRuntimeMode({ packed, embeddedBuildInfo: embedded });
    const [workspace, theme] = await Promise.all([
      Promise.resolve()
        .then(() => readWorkspaceSource())
        .then((value) => describeWorkspaceSource(value || {}))
        .catch(() => describeWorkspaceSource({})),
      themeSnapshot(),
    ]);

    const build = (() => {
      try { return readBuildSnapshot(); } catch { return null; }
    })();
    const completed = describeLastBuild(build);
    if (completed) lastCompleted = completed;

    return {
      mode,
      entrypoint: describeEntrypoint({ mode, executablePath }),
      appVersion: (() => {
        try {
          const value = readAppVersion();
          return typeof value === 'string' && value.trim() ? value.trim() : UNKNOWN;
        } catch {
          return UNKNOWN;
        }
      })(),
      nodeVersion: typeof nodeVersion === 'string' ? nodeVersion : UNKNOWN,
      embeddedBuildInfo: embedded,
      workspaceSource: workspace,
      theme,
      port: (() => {
        const value = Number(getPort());
        return Number.isInteger(value) && value > 0 ? value : 0;
      })(),
      publicDir: publicDir ? String(publicDir) : UNKNOWN,
      lastBuild: completed || lastCompleted,
      provenance: resolveProvenance({ mode, embeddedBuildInfo: embedded, workspaceSource: workspace }),
    };
  }

  return { snapshot };
}
