import { spawn } from 'node:child_process';

function appendBounded(current, chunk, maxBytes) {
  const next = current + Buffer.from(chunk).toString('utf8');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
  const bytes = Buffer.from(next, 'utf8');
  return `…（输出已截断）\n${bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8')}`;
}

export function createProcessRunner({
  spawnProcess = spawn,
  defaultTimeoutMs = 60_000,
  defaultMaxOutputBytes = 64 * 1024,
} = {}) {
  async function run(command, args = [], {
    cwd,
    env,
    timeoutMs = defaultTimeoutMs,
    maxOutputBytes = defaultMaxOutputBytes,
    signal,
    killSignal = 'SIGTERM',
    windowsHide = true,
  } = {}) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timeoutId = null;
      let stdout = '';
      let stderr = '';
      let output = '';
      let timedOut = false;
      let aborted = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener?.('abort', onAbort);
        resolve({ stdout, stderr, output, timedOut, aborted, ...result });
      };

      const stop = (kind) => {
        if (settled) return;
        timedOut ||= kind === 'timeout';
        aborted ||= kind === 'abort';
        try { child?.kill?.(killSignal); } catch {}
        finish({
          code: 1,
          signal: killSignal,
          error: kind === 'timeout'
            ? `process timed out after ${timeoutMs}ms`
            : 'process aborted',
        });
      };

      const onAbort = () => stop('abort');

      if (signal?.aborted) {
        finish({ code: 1, signal: null, aborted: true, error: 'process aborted' });
        return;
      }

      try {
        child = spawnProcess(command, args, {
          cwd,
          env,
          windowsHide,
          shell: false,
        });
      } catch (error) {
        finish({ code: 1, signal: null, error: error?.message || String(error) });
        return;
      }

      child.stdout?.on('data', (data) => {
        stdout = appendBounded(stdout, data, maxOutputBytes);
        output = appendBounded(output, data, maxOutputBytes);
      });
      child.stderr?.on('data', (data) => {
        stderr = appendBounded(stderr, data, maxOutputBytes);
        output = appendBounded(output, data, maxOutputBytes);
      });
      child.on('close', (code, closedSignal) => finish({
        code: Number.isInteger(code) ? code : 1,
        signal: closedSignal || null,
      }));
      child.on('error', (error) => finish({
        code: 1,
        signal: null,
        error: error?.message || String(error),
        stderr: stderr || (error?.message || String(error)),
      }));

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timeoutId = setTimeout(() => stop('timeout'), timeoutMs);
    });
  }

  return { run };
}
