import { spawn } from 'node:child_process';

import { redactGitCredentials } from '../domain/publish-security.mjs';

export function gitEnvironment(config = [], baseEnv = process.env) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  if (config.length) {
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = String(key);
      env[`GIT_CONFIG_VALUE_${index}`] = String(value);
    });
  }
  return env;
}

export function isTransientGitNetworkFailure(result) {
  return /failed to connect|could not resolve|connection (?:was )?reset|timed? out|tls connect|http\/2 stream|schannel/i.test(`${result.stderr}\n${result.stdout}`);
}

export function createGitService({
  repoRoot,
  spawnProcess = spawn,
  platform = process.platform,
  environment = process.env,
}) {
  let proxyCache;

  function run(command, args, options = {}) {
    return new Promise((resolve) => {
      const child = spawnProcess(command, args, {
        cwd: repoRoot,
        windowsHide: true,
        shell: false,
        ...options,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data) => { stdout += data; });
      child.stderr?.on('data', (data) => { stderr += data; });
      child.on('close', (code) => resolve({ code: Number.isInteger(code) ? code : 1, stdout, stderr }));
      child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
    });
  }

  function git(args, config = []) {
    return run('git', args, { env: gitEnvironment(config, environment) });
  }

  async function systemGitProxy() {
    if (proxyCache !== undefined) return proxyCache;
    const environmentProxy = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy;
    if (environmentProxy) {
      try {
        const parsed = new URL(environmentProxy);
        if (/^https?:$/.test(parsed.protocol) && parsed.hostname) return (proxyCache = parsed.href);
      } catch {}
    }

    if (platform !== 'win32') return (proxyCache = '');
    const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const [enabled, configured] = await Promise.all([
      run('reg.exe', ['query', registryKey, '/v', 'ProxyEnable']),
      run('reg.exe', ['query', registryKey, '/v', 'ProxyServer']),
    ]);
    if (enabled.code !== 0 || configured.code !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout)) return (proxyCache = '');

    const raw = configured.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)$/im)?.[1]?.trim() || '';
    const entries = raw.split(';').map((entry) => entry.trim()).filter(Boolean);
    const selected = entries.find((entry) => /^https=/i.test(entry))
      || entries.find((entry) => /^http=/i.test(entry))
      || entries[0]
      || '';
    const address = selected.replace(/^[a-z]+=/i, '');
    if (!address || /[\r\n]/.test(address)) return (proxyCache = '');
    const normalized = /^[a-z]+:\/\//i.test(address) ? address : `http://${address}`;
    try {
      const parsed = new URL(normalized);
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return (proxyCache = '');
      return (proxyCache = parsed.href);
    } catch {
      return (proxyCache = '');
    }
  }

  async function gitNetwork(args, config = []) {
    const proxy = await systemGitProxy();
    const transport = proxy ? [['http.proxy', proxy]] : [];
    let result = await git(args, [...transport, ...config]);
    if (result.code !== 0 && isTransientGitNetworkFailure(result)) {
      result = await git(args, [['http.version', 'HTTP/1.1'], ...transport, ...config]);
      result.retried = true;
    }
    result.proxyDetected = Boolean(proxy);
    return result;
  }

  function safeGitFailure(result, token = '') {
    const detail = redactGitCredentials(result.stderr || result.stdout, token);
    if (isTransientGitNetworkFailure(result)) {
      const route = result.proxyDetected
        ? '已读取 Windows 系统代理并重试一次'
        : '未检测到可用系统代理，已用 HTTP/1.1 重试一次';
      return `无法连接 GitHub 主站（${route}）。请确认代理正在运行后再点发布。`;
    }
    if (/authentication failed|invalid username or password|403|401/i.test(detail)) {
      return 'GitHub 认证失败，请更新博客根目录的 .token。';
    }
    return detail.slice(0, 800);
  }

  async function gitChanges() {
    const result = await git(['-c', 'core.quotepath=false', 'status', '--short']);
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2).trim() || '??',
      path: line.slice(3).trim().replaceAll('\\', '/'),
    }));
  }

  return { git, gitNetwork, systemGitProxy, safeGitFailure, gitChanges };
}
