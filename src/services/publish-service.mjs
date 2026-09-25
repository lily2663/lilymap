import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isSensitivePublishPath, publishPushArguments, validatePublishToken } from '../domain/publish-security.mjs';

export function validBlogRemote(value) {
  return typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

export function validPublishBranch(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.endsWith('/')
    && !value.endsWith('.lock');
}

function normalizedRemote(value) {
  return String(value || '').trim().toLowerCase().replace(/\.git$/, '');
}

function validationError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function createPublishService({
  repoRoot,
  trashRoot,
  exists,
  atomicWrite,
  git,
  gitNetwork,
  safeGitFailure,
}) {
  const localConfigFile = path.join(repoRoot, '.lilymap-local.json');
  const tokenFile = path.join(repoRoot, '.token');

  async function readConfig() {
    if (!(await exists(localConfigFile))) return {};
    return JSON.parse(await fs.readFile(localConfigFile, 'utf8'));
  }

  async function remote() {
    const config = await readConfig();
    if (validBlogRemote(config.publishRemote)) return config.publishRemote;
    const current = await git(['remote', 'get-url', 'github']);
    return current.code === 0 && validBlogRemote(current.stdout.trim()) ? current.stdout.trim() : '';
  }

  async function branch() {
    const config = await readConfig();
    return validPublishBranch(config.publishBranch) ? config.publishBranch : 'main';
  }

  async function tokenPresent() {
    return exists(tokenFile);
  }

  async function saveToken(value) {
    const token = validatePublishToken(value);
    if (!token) throw validationError('令牌格式无效：应为只含字母、数字或下划线的 20–2048 个字符。');
    await atomicWrite(tokenFile, `${token}\n`, { schedule: false });
    await fs.chmod(tokenFile, 0o600).catch(() => {});
    return { tokenPresent: true };
  }

  async function setTarget(value, branchValue = 'main') {
    const targetRemote = String(value || '').trim();
    const targetBranch = String(branchValue || 'main').trim();
    if (!validBlogRemote(targetRemote)) throw validationError('请输入完整的 GitHub HTTPS 仓库地址。');
    if (!validPublishBranch(targetBranch)) throw validationError('发布分支名无效。');

    const current = await git(['remote', 'get-url', 'github']);
    const previous = current.code === 0 ? current.stdout.trim() : '';
    const expected = await remote();
    if (previous && normalizedRemote(previous) !== normalizedRemote(expected)) {
      throw validationError('Git 远程已被其他程序修改，请先核对当前地址。', 409);
    }

    const update = await git(previous ? ['remote', 'set-url', 'github', targetRemote] : ['remote', 'add', 'github', targetRemote]);
    if (update.code !== 0) throw validationError(update.stderr || '无法更新 Git 远程。', 500);

    try {
      await atomicWrite(localConfigFile, `${JSON.stringify({ ...(await readConfig()), publishRemote: targetRemote, publishBranch: targetBranch }, null, 2)}\n`, { schedule: false });
    } catch (error) {
      await git(previous ? ['remote', 'set-url', 'github', previous] : ['remote', 'remove', 'github']);
      throw error;
    }
    return { remote: targetRemote, branch: targetBranch };
  }

  async function ensureRemote(expected) {
    if (!validBlogRemote(expected)) throw new Error('尚未设置有效的 GitHub 发布目标。');
    const current = await git(['remote', 'get-url', 'github']);
    if (current.code === 0) {
      const url = current.stdout.trim();
      if (normalizedRemote(url) !== normalizedRemote(expected)) throw new Error(`github 远程与 LilyMap 发布目标不一致：${url}`);
      return;
    }
    const add = await git(['remote', 'add', 'github', expected]);
    if (add.code !== 0) throw new Error(`无法添加 github 远程：${add.stderr.trim()}`);
  }

  async function publishToBlog(commitMessage, force, report = () => {}) {
    report(5, '正在检查 GitHub 凭据');
    if (!(await exists(tokenFile))) throw new Error('未找到 GitHub 认证 token（.token）。');
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('token 为空。');

    report(12, '正在确认目标仓库');
    await ensureRemote(await remote());
    const targetBranch = await branch();

    report(20, '正在整理本地变更');
    const trackedLocal = await git(['ls-files', '--', '.token', '.lilymap-local.json', 'lilymap.json', 'hugo-desk.json', '.secrets', 'private-content', '.admin-trash', '.backups']);
    if (trackedLocal.code !== 0) throw new Error(`无法检查本机敏感文件：${trackedLocal.stderr.trim()}`);
    const trackedSensitive = trackedLocal.stdout.split(/\r?\n/).filter(Boolean).filter(isSensitivePublishPath);
    if (trackedSensitive.length) throw new Error(`检测到不应进入 Git 的本机文件：${trackedSensitive.slice(0, 5).join(', ')}。请先从 Git 索引移除后再发布。`);

    const add = await git([
      'add', '-A', '--', '.',
      ':(exclude).token',
      ':(exclude).lilymap-local.json',
      ':(exclude)lilymap.json',
      ':(exclude)hugo-desk.json',
      ':(exclude).secrets/**',
      ':(exclude)private-content/**',
      ':(exclude).admin-trash/**',
      ':(exclude).backups/**',
    ]);
    if (add.code !== 0) throw new Error(`git add 失败：${add.stderr.trim()}`);

    const stagedNames = await git(['diff', '--cached', '--name-only', '--']);
    if (stagedNames.code !== 0) throw new Error(`无法检查暂存区：${stagedNames.stderr.trim()}`);
    const stagedSensitive = stagedNames.stdout.split(/\r?\n/).filter(Boolean).filter(isSensitivePublishPath);
    if (stagedSensitive.length) throw new Error(`暂存区包含本机敏感文件，已拒绝发布：${stagedSensitive.slice(0, 5).join(', ')}。`);

    const staged = await git(['diff', '--cached', '--quiet']);
    report(30, staged.code !== 0 ? '正在创建本次提交' : '没有新文件需要提交');
    if (staged.code !== 0) {
      const message = String(commitMessage || '').slice(0, 200).trim() || 'chore: publish blog updates';
      const msgFile = path.join(trashRoot, `commit-msg-${Date.now()}.txt`);
      await fs.mkdir(trashRoot, { recursive: true });
      await fs.writeFile(msgFile, message, 'utf8');
      const commit = await git(['-c', 'i18n.commitencoding=utf-8', 'commit', '-F', msgFile]);
      await fs.rm(msgFile, { force: true }).catch(() => {});
      if (commit.code !== 0) throw new Error(`git commit 失败：${commit.stderr.trim()}`);
    }

    const authConfig = [[`url.https://oauth2:${token}@github.com/.insteadOf`, 'https://github.com/']];
    report(46, '正在获取 GitHub 上的最新版本');
    const fetch = await gitNetwork(['fetch', 'github', targetBranch], authConfig);
    let newRemoteBranch = false;
    if (fetch.code !== 0 && force) {
      const probe = await gitNetwork(['ls-remote', 'github', `refs/heads/${targetBranch}`], authConfig);
      newRemoteBranch = probe.code === 0 && !probe.stdout.trim();
    }
    if (fetch.code !== 0 && !newRemoteBranch) throw new Error(`git fetch 失败：${safeGitFailure(fetch, token)}`);

    let remoteSha = '';
    if (!newRemoteBranch) {
      const remoteHead = await git(['rev-parse', 'FETCH_HEAD']);
      remoteSha = remoteHead.code === 0 ? remoteHead.stdout.trim() : '';
      if (!/^[0-9a-f]{40}$/i.test(remoteSha)) throw new Error('无法确定远程分支基线，已停止发布。');
    }

    if (!newRemoteBranch && !force) {
      report(64, '正在检查远程差异');
      const remoteOnly = await git(['rev-list', '--count', 'FETCH_HEAD', '--not', 'HEAD']);
      if (Number(remoteOnly.stdout.trim() || '0') > 0) {
        report(73, '正在安全整合远程修改');
        const rebase = await git(['rebase', 'FETCH_HEAD']);
        if (rebase.code !== 0) {
          await git(['rebase', '--abort']);
          throw new Error('远程包含与本地冲突的修改，已安全中止。请先在 GitHub 上查看远程改动再发布。');
        }
      }
    }

    report(86, force ? '正在使用远程租约安全替换当前源码' : '正在推送到 GitHub');
    const push = await gitNetwork(publishPushArguments(targetBranch, { force, newRemoteBranch, remoteSha }), authConfig);
    let reconciledAfterAmbiguousFailure = false;
    if (push.code !== 0) {
      report(93, '推送结果不明确，正在核对 GitHub 远端状态');
      const localHead = await git(['rev-parse', 'HEAD']);
      const localSha = localHead.code === 0 ? localHead.stdout.trim() : '';
      const probe = await gitNetwork(['ls-remote', 'github', `refs/heads/${targetBranch}`], authConfig);
      const publishedSha = probe.code === 0 ? probe.stdout.trim().split(/\s+/)[0] || '' : '';
      if (/^[0-9a-f]{40}$/i.test(localSha) && publishedSha.toLowerCase() === localSha.toLowerCase()) {
        reconciledAfterAmbiguousFailure = true;
      } else {
        throw new Error(`push 失败：${safeGitFailure(push, token)}`);
      }
    }

    report(100, reconciledAfterAmbiguousFailure ? '已确认源码实际推送成功，GitHub Actions 正在构建' : '源码已推送，GitHub Actions 正在构建');
    return {
      message: commitMessage ? `已推送 ${commitMessage}` : `已推送到 ${targetBranch} 分支`,
      reconciledAfterAmbiguousFailure,
    };
  }

  return { remote, branch, tokenPresent, saveToken, setTarget, publishToBlog };
}
