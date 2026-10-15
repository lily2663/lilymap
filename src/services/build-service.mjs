import path from 'node:path';

import { createProcessRunner } from './process-runner.mjs';

export function createBuildService({
  repoRoot,
  hugoExecutable,
  maxOutputBytes = 16 * 1024,
  buildTimeoutMs = 120_000,
  spawnProcess,
  processRunner,
  onError = (message) => console.error(message),
}) {
  const runner = processRunner || createProcessRunner({
    ...(spawnProcess ? { spawnProcess } : {}),
    defaultTimeoutMs: buildTimeoutMs,
    defaultMaxOutputBytes: maxOutputBytes,
  });
  const state = {
    status: 'idle',
    trigger: '',
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    code: null,
    output: '',
  };
  let timer = null;
  let scheduledAt = null;
  let scheduledReady = false;
  let active = false;
  const requests = [];

  function trimOutput(value) {
    const output = String(value || '');
    const bytes = Buffer.from(output, 'utf8');
    if (bytes.length <= maxOutputBytes) return output;
    let start = Math.max(0, bytes.length - maxOutputBytes);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return `…（输出已截断）\n${bytes.subarray(start).toString('utf8')}`;
  }

  function snapshot() {
    const queuedAt = requests[0]?.queuedAt || scheduledAt;
    if (!active && queuedAt) {
      return {
        ...state,
        status: 'queued',
        trigger: requests[0]?.trigger || 'scheduled',
        queuedAt,
        finishedAt: null,
        code: null,
        output: '',
      };
    }
    return { ...state, queuedAt };
  }

  function cancelScheduledBuild() {
    const cancelled = timer !== null || scheduledReady;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    scheduledAt = null;
    scheduledReady = false;
    return cancelled;
  }

  function scheduleBuild(delay = 500) {
    if (timer !== null) clearTimeout(timer);
    scheduledAt = new Date().toISOString();
    scheduledReady = false;
    timer = setTimeout(() => {
      timer = null;
      scheduledReady = true;
      void drain();
    }, delay);
  }

  async function execute(minify) {
    const args = minify
      ? ['--gc', '--minify', '--cacheDir', path.join(repoRoot, '.cache', 'hugo')]
      : ['--cacheDir', path.join(repoRoot, '.cache', 'hugo')];

    const result = await runner.run(hugoExecutable, args, {
      cwd: repoRoot,
      timeoutMs: buildTimeoutMs,
      maxOutputBytes,
    });
    let output = result.output || result.stderr || result.stdout || result.error || '';
    if (/\bENOENT\b/i.test(result.error || result.stderr || '')) {
      output = '未找到 Hugo。请安装 Hugo，或在 lilymap.json 中设置 hugoPath。';
    } else if (result.timedOut) {
      output = `Hugo 构建超过 ${Math.ceil(buildTimeoutMs / 1000)} 秒，已终止。`;
    } else if (result.aborted) {
      output = 'Hugo 构建已取消。';
    }
    return { code: result.code, output };
  }

  async function drain() {
    if (active) return;
    let request = requests.shift();
    if (!request && scheduledReady) {
      request = { minify: false, trigger: 'scheduled' };
      scheduledReady = false;
      scheduledAt = null;
    }
    if (!request) return;

    active = true;
    state.status = 'running';
    state.trigger = request.trigger;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    state.code = null;
    state.output = '';

    let result;
    try {
      result = await execute(request.minify);
    } catch (error) {
      result = { code: 1, output: error?.message || 'Hugo 构建过程异常。' };
    }

    state.code = result.code;
    state.output = trimOutput(result.output);
    state.finishedAt = new Date().toISOString();
    state.status = result.code === 0 ? 'success' : 'error';
    const completed = { ...result, output: state.output, build: { ...state } };
    if (result.code !== 0) {
      // Diagnostic callbacks must not strand callers or prevent the next build.
      try { onError(`Hugo 构建失败：${state.output}`); } catch {}
    }
    active = false;
    request.resolve?.(completed);
    void drain();
  }

  function runBuild(minify = false, trigger = 'manual') {
    // An explicit build includes all changes that prompted the pending auto-build.
    cancelScheduledBuild();
    const task = new Promise((resolve) => {
      requests.push({ minify, trigger, resolve, queuedAt: new Date().toISOString() });
    });
    void drain();
    return task;
  }

  return { scheduleBuild, cancelScheduledBuild, runBuild, snapshot };
}
