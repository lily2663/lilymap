import path from 'node:path';
import { spawn } from 'node:child_process';

export function createBuildService({
  repoRoot,
  hugoExecutable,
  maxOutputBytes = 16 * 1024,
  spawnProcess = spawn,
  onError = (message) => console.error(message),
}) {
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

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawnProcess(hugoExecutable, args, { cwd: repoRoot, windowsHide: true, shell: false });
      let output = '';
      child.stdout?.on('data', (data) => { output += data; });
      child.stderr?.on('data', (data) => { output += data; });
      child.on('close', (code) => finish({ code: Number.isInteger(code) ? code : 1, output }));
      child.on('error', (error) => finish({
        code: 1,
        output: error.message === 'spawn hugo ENOENT'
          ? '未找到 Hugo。请安装 Hugo，或在 lilymap.json 中设置 hugoPath。'
          : error.message,
      }));
    });
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
