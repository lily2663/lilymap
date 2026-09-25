export function validatePublishToken(value) {
  const token = String(value || '').trim();
  if (token.length < 20 || token.length > 2048 || !/^[A-Za-z0-9_]+$/.test(token)) return null;
  return token;
}

export function redactGitCredentials(value, token = '') {
  let detail = String(value || '未知 Git 错误').trim();
  if (token) detail = detail.split(token).join('[REDACTED]');
  detail = detail.replace(/https:\/\/[^\s@]+@github\.com/gi, 'https://[REDACTED]@github.com');
  return detail.replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function isSensitivePublishPath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === '.token'
    || normalized === '.lilymap-local.json'
    || normalized === 'lilymap.json'
    || normalized === 'hugo-desk.json'
    || normalized === '.secrets'
    || normalized.startsWith('.secrets/')
    || normalized === 'private-content'
    || normalized.startsWith('private-content/')
    || normalized === '.admin-trash'
    || normalized.startsWith('.admin-trash/')
    || normalized === '.backups'
    || normalized.startsWith('.backups/');
}


export function publishPushArguments(branch, { force = false, newRemoteBranch = false, remoteSha = '' } = {}) {
  const ref = `HEAD:refs/heads/${branch}`;
  if (!force || newRemoteBranch) return ['push', 'github', ref];
  if (!/^[0-9a-f]{40}$/i.test(remoteSha)) throw new Error('强制发布缺少有效的远程基线提交。');
  return ['push', `--force-with-lease=refs/heads/${branch}:${remoteSha}`, 'github', ref];
}
