import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveInside } from '../fs/path-security.mjs';
import { createProcessRunner } from './process-runner.mjs';

const scriptRelativePath = 'scripts/optimize-images.mjs';
const manifestRelativePath = 'data/image_variants.json';
const maximumManifestBytes = 8 * 1024 * 1024;
const maximumManifestImages = 10_000;
const maximumCandidatesPerImage = 20;

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function boundedOutput(value, maximumBytes) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= maximumBytes) return bytes.toString('utf8');
  return `…（输出已截断）\n${bytes.subarray(-maximumBytes).toString('utf8')}`;
}

function imagePath(repoRoot, url, candidate = false) {
  const prefix = candidate ? '/assets/img/responsive/' : '/assets/img/';
  if (typeof url !== 'string' || !url.startsWith(prefix) || /[\\\0?#%:]/.test(url)) return null;
  if (url.split('/').some((part) => part === '.' || part === '..')) return null;
  if (!candidate && url.startsWith('/assets/img/responsive/')) return null;
  if (!(candidate ? /\.webp$/i : /\.(?:png|jpe?g|webp)$/i).test(url)) return null;
  return resolveInside(repoRoot, `static${url}`);
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Reading the image header avoids starting an external inspector for every GET.
async function webpDimensions(file) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(64);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8 ' && bytes.toString('hex', 23, 26) === '9d012a') {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const dimensions = bytes.readUInt32LE(21);
      return { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
    }
    return null;
  } finally {
    await handle.close();
  }
}

const emptyManifest = (status = 'missing', reason = '') => ({
  status, reason, totalImages: 0, validImages: 0, invalidImages: 0,
  validCandidates: 0, invalidCandidates: 0, sourceBytes: 0, candidateBytes: 0,
});

export function createImageOptimizationService({
  repoRoot,
  nodeExecutable = process['pkg'] ? 'node' : process.execPath,
  optimizationTimeoutMs = 5 * 60_000,
  maxOutputBytes = 32 * 1024,
  processRunner,
  spawnProcess,
  scheduleBuild = () => {},
} = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');
  const root = path.resolve(repoRoot);
  const timeoutMs = Number.isFinite(optimizationTimeoutMs) && optimizationTimeoutMs > 0
    ? Math.min(optimizationTimeoutMs, 15 * 60_000) : 5 * 60_000;
  const outputLimit = Number.isInteger(maxOutputBytes) && maxOutputBytes > 0
    ? Math.min(maxOutputBytes, 256 * 1024) : 32 * 1024;
  const runner = processRunner || createProcessRunner({
    ...(spawnProcess ? { spawnProcess } : {}),
    defaultTimeoutMs: timeoutMs,
    defaultMaxOutputBytes: outputLimit,
  });
  const task = {
    status: 'idle', id: 0, startedAt: null, finishedAt: null, code: null,
    output: '', error: '', warning: '', timedOut: false, aborted: false,
  };
  let active = null;

  async function availability() {
    const script = resolveInside(root, scriptRelativePath);
    const present = script && await fs.stat(script).then((stat) => stat.isFile()).catch(() => false);
    return {
      supported: Boolean(present),
      reason: present ? '' : '当前项目未提供响应式图片脚本，暂不支持此功能。',
    };
  }

  async function manifestStatistics() {
    const file = resolveInside(root, manifestRelativePath);
    if (!file) return emptyManifest('invalid', '图片清单路径不安全。');
    let manifest;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > maximumManifestBytes) return emptyManifest('invalid', '图片清单大小或文件类型无效。');
      manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      return error.code === 'ENOENT' ? emptyManifest() : emptyManifest('invalid', '图片清单无法读取或格式无效。');
    }
    if (manifest?.version !== 1 || !manifest.images || typeof manifest.images !== 'object' || Array.isArray(manifest.images)) {
      return emptyManifest('invalid', '图片清单格式无效。');
    }
    const images = Object.entries(manifest.images);
    if (images.length > maximumManifestImages) return emptyManifest('invalid', '图片清单条目过多。');
    const statistics = { ...emptyManifest('ready'), totalImages: images.length };
    for (const [url, image] of images) {
      const candidates = Array.isArray(image?.candidates) ? image.candidates : [];
      const source = imagePath(root, url);
      let sourceStat;
      try {
        sourceStat = source && await fs.stat(source);
        if (!sourceStat?.isFile() || !/^[a-f0-9]{64}$/.test(image?.sha256 || '')
          || !Number.isInteger(image?.width) || image.width <= 0
          || !Number.isInteger(image?.height) || image.height <= 0
          || candidates.length > maximumCandidatesPerImage
          || await hashFile(source) !== image.sha256) throw new Error('invalid source');
      } catch {
        statistics.invalidImages += 1;
        statistics.invalidCandidates += candidates.length;
        continue;
      }
      let valid = 0;
      const widths = new Set();
      const urls = new Set();
      for (const candidate of candidates) {
        const candidatePath = imagePath(root, candidate?.url, true);
        try {
          if (!candidatePath || !Number.isInteger(candidate.width) || candidate.width <= 0 || candidate.width >= image.width
            || !Number.isInteger(candidate.height) || candidate.height <= 0
            || !Number.isInteger(candidate.bytes) || candidate.bytes <= 0
            || widths.has(candidate.width) || urls.has(candidate.url)) throw new Error('invalid candidate');
          const stat = await fs.stat(candidatePath);
          if (!stat.isFile() || stat.size !== candidate.bytes || stat.size >= sourceStat.size) throw new Error('missing candidate');
          const dimensions = await webpDimensions(candidatePath);
          if (dimensions?.width !== candidate.width || dimensions?.height !== candidate.height) throw new Error('invalid dimensions');
          widths.add(candidate.width);
          urls.add(candidate.url);
          valid += 1;
          statistics.validCandidates += 1;
          statistics.candidateBytes += stat.size;
        } catch {
          statistics.invalidCandidates += 1;
        }
      }
      if (valid) {
        statistics.validImages += 1;
        statistics.sourceBytes += sourceStat.size;
      } else statistics.invalidImages += 1;
    }
    return statistics;
  }

  async function snapshot() {
    const [support, manifest] = await Promise.all([availability(), manifestStatistics()]);
    return { ...support, manifest, task: { ...task } };
  }

  async function execute(script) {
    try {
      const result = await runner.run(nodeExecutable, [script, '--responsive'], {
        cwd: root, timeoutMs, maxOutputBytes: outputLimit, killSignal: 'SIGKILL',
      });
      task.code = Number.isInteger(result.code) ? result.code : 1;
      task.timedOut = Boolean(result.timedOut);
      task.aborted = Boolean(result.aborted);
      task.output = boundedOutput(result.output || result.stderr || result.stdout || result.error, outputLimit);
      task.error = result.timedOut ? `图片优化超过 ${Math.ceil(timeoutMs / 1000)} 秒，已终止。`
        : result.aborted ? '图片优化已取消。'
          : result.error || (task.code ? '图片优化失败，请查看输出。' : '');
      task.status = task.code === 0 && !task.timedOut && !task.aborted && !task.error ? 'success' : 'error';
      if (task.status === 'success') {
        try { await scheduleBuild(); }
        catch (error) { task.warning = boundedOutput(`图片已生成，但预览构建未能排队：${error.message || '未知错误'}`, outputLimit); }
      }
    } catch (error) {
      task.code = 1;
      task.status = 'error';
      task.error = error.message || '图片优化过程异常。';
      task.output = boundedOutput(task.error, outputLimit);
    } finally {
      task.finishedAt = new Date().toISOString();
    }
  }

  async function start() {
    if (active) throw statusError(409, '图片优化正在运行，请稍后查看结果。');
    // Reserve before the first await so simultaneous requests cannot start two jobs.
    let releaseReservation;
    active = new Promise((resolve) => { releaseReservation = resolve; });
    const reservation = active;
    try {
      const support = await availability();
      if (!support.supported) throw statusError(501, support.reason);
      const script = resolveInside(root, scriptRelativePath);
      Object.assign(task, {
        status: 'running', id: task.id + 1, startedAt: new Date().toISOString(), finishedAt: null,
        code: null, output: '', error: '', warning: '', timedOut: false, aborted: false,
      });
      void Promise.resolve().then(() => execute(script)).finally(() => {
        if (active === reservation) active = null;
        releaseReservation();
      });
      return snapshot();
    } catch (error) {
      if (active === reservation) active = null;
      releaseReservation();
      throw error;
    }
  }

  return { snapshot, start, waitForIdle: async () => { while (active) await active; } };
}
