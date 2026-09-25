import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createPublishRoutes({
  repoRoot,
  readBody,
  send,
  fail,
  publishService,
  git,
  gitChanges,
  systemGitProxy,
  exists,
}) {
  let publishState = null;

  function snapshot() {
    if (!publishState) return null;
    return {
      id: publishState.id,
      status: publishState.status,
      progress: publishState.progress,
      stage: publishState.stage,
      message: publishState.message,
      error: publishState.error,
      force: publishState.force,
      startedAt: publishState.startedAt,
      finishedAt: publishState.finishedAt,
    };
  }

  return async function handlePublishRoutes(req, res, url) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/publish')) return false;

    if (req.method === 'GET' && pathname === '/api/publish/status') {
      const remote = await git(['remote', 'get-url', 'github']);
      const targetRemote = await publishService.remote();
      const remoteOk = Boolean(targetRemote)
        && remote.code === 0
        && remote.stdout.trim().toLowerCase().replace(/\.git$/, '') === targetRemote.toLowerCase().replace(/\.git$/, '');
      let commitsAhead = '0';
      try {
        const ahead = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes=github']);
        commitsAhead = ahead.stdout.trim() || '0';
      } catch {}
      send(res, 200, {
        allowedRemote: targetRemote.replace(/\.git$/, ''),
        allowedBranch: await publishService.branch(),
        remote: remote.code === 0 ? remote.stdout.trim() : '',
        remoteOk,
        tokenPresent: await publishService.tokenPresent(),
        systemProxyDetected: Boolean(await systemGitProxy()),
        workflowPresent: await exists(path.join(repoRoot, '.github', 'workflows', 'hugo.yaml')),
        branch: (await git(['branch', '--show-current'])).stdout.trim(),
        changes: await gitChanges(),
        commitsAhead,
        publishJob: snapshot(),
      });
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/publish/target') {
      if (publishState?.status === 'running') {
        fail(res, 409, '发布进行中，暂不能切换目标。');
        return true;
      }
      try {
        const request = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        const result = await publishService.setTarget(request.remote, request.branch);
        send(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, error.message || '无法更新发布目标。');
      }
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/publish/token') {
      if (publishState?.status === 'running') {
        fail(res, 409, '发布进行中，暂不能修改认证令牌。');
        return true;
      }
      try {
        const request = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        send(res, 200, { ok: true, ...(await publishService.saveToken(request.token)) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, error.message || '无法保存认证令牌。');
      }
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/publish/progress') {
      const id = url.searchParams.get('id');
      if (!publishState || (id && id !== publishState.id)) {
        fail(res, 404, '没有找到这次发布任务。');
      } else {
        send(res, 200, snapshot());
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/publish') {
      let request = {};
      try { request = JSON.parse((await readBody(req)).toString('utf8')); } catch {}
      const force = request.force === true;
      const commitMessage = String(request.commit || '').trim();

      if (publishState?.status === 'running') {
        fail(res, 409, '已有发布任务正在执行，请等待当前进度完成。');
        return true;
      }

      publishState = {
        id: randomUUID(),
        status: 'running',
        progress: 2,
        stage: '正在准备发布',
        message: '',
        error: '',
        force,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };

      const report = (progress, stage) => {
        if (publishState?.status !== 'running') return;
        publishState.progress = Math.max(publishState.progress, Math.min(100, Number(progress) || 0));
        publishState.stage = String(stage || publishState.stage).slice(0, 160);
      };

      void publishService.publishToBlog(commitMessage, force, report).then((result) => {
        publishState.status = 'complete';
        publishState.progress = 100;
        publishState.stage = '发布完成';
        publishState.message = result.message;
        publishState.finishedAt = new Date().toISOString();
      }).catch((error) => {
        publishState.status = 'failed';
        publishState.stage = '发布失败';
        publishState.error = String(error?.message || '发布失败。').slice(0, 1000);
        publishState.finishedAt = new Date().toISOString();
      });

      send(res, 202, { ok: true, ...snapshot() });
      return true;
    }

    return false;
  };
}
