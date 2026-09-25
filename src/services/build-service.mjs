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
  let chain = Promise.resolve();

  function trimOutput(value) {
    const output = String(value || '');
    if (Buffer.byteLength(output, 'utf8') <= maxOutputBytes) return output;
    return `…（输出已截断）\n${output.slice(-maxOutputBytes)}`;
  }

  function snapshot() {
    return { ...state, output: trimOutput(state.output) };
  }

  function cancelScheduledBuild() {
    if (!timer) return false;
    clearTimeout(timer);
    timer = null;
    if (state.status === 'queued') state.status = 'idle';
    state.queuedAt = null;
    return true;
  }

  function scheduleBuild(delay = 500) {
    if (timer) clearTimeout(timer);
    state.queuedAt = new Date().toISOString();
    if (state.status !== 'running') state.status = 'queued';
    state.trigger = 'scheduled';
    timer = setTimeout(() => {
      timer = null;
      void runBuild(false, 'scheduled');
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
    if (/spawn hugo ENOENT/i.test(result.error || result.stderr || '')) {
      output = '未找到 Hugo。请安装 Hugo，或在 lilymap.json 中设置 hugoPath。';
    } else if (result.timedOut) {
      output = `Hugo 构建超过 ${Math.ceil(buildTimeoutMs / 1000)} 秒，已终止。`;
    } else if (result.aborted) {
      output = 'Hugo 构建已取消。';
    }
    return { code: result.code, output };
  }

  async function runBuild(minify = false, trigger = 'manual') {
    if (state.status !== 'running') state.status = 'queued';
    state.queuedAt ||= new Date().toISOString();
    state.trigger = trigger;

    const task = chain.then(async () => {
      state.status = 'running';
      state.startedAt = new Date().toISOString();
      state.finishedAt = null;
      state.code = null;
      state.output = '';
      state.queuedAt = null;

      let result;
      try {
        result = await execute(minify);
      } catch (error) {
        result = { code: 1, output: error.message || 'Hugo 构建过程异常。' };
      }

      state.code = result.code;
      state.output = trimOutput(result.output);
      state.finishedAt = new Date().toISOString();
      state.status = result.code === 0 ? 'success' : 'error';
      if (result.code !== 0) onError(`Hugo 构建失败：${state.output}`);
      return { ...result, output: trimOutput(result.output), build: snapshot() };
    });

    chain = task.catch(() => {});
    return task;
  }

  return { scheduleBuild, cancelScheduledBuild, runBuild, snapshot };
}
