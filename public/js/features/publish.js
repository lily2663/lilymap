import { api } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';

let publishTracker = 0;

export async function renderPublish({ page, bindCommon }) {
  const s = await api('/api/publish/status');
  const ok = s.tokenPresent && s.remoteOk && s.workflowPresent;
  const chg = s.changes.length;
  const card = (value, label) => {
    const on = value === true;
    const className = value === false ? 'danger' : '';
    return `<div><b class="${className}">${label}</b><small>${on ? '已就绪' : value === false ? '未就绪' : value}</small></div>`;
  };

  $('#main').innerHTML =
    page(
      '发布',
      '把 Hugo 源码推送到选定的 GitHub 仓库，触发仓库中的构建工作流。',
      '<button class="btn" id="pub-refresh">刷新状态</button>',
    ) +
    `<div class="publish-setup"><section class="section"><span class="publish-step">01 / DESTINATION</span><h2>发布目标</h2><p class="muted">选择你有写入权限的 GitHub 仓库；仓库中还需配置适用的构建工作流。</p><label class="field"><span>GitHub 仓库地址</span><input id="pub-target" value="${esc(s.allowedRemote)}" placeholder="https://github.com/owner/repo.git" autocomplete="off" spellcheck="false"></label><p><button class="btn" id="pub-target-save" type="button">保存发布目标</button></p></section><section class="section"><span class="publish-step">02 / CREDENTIAL</span><h2>认证令牌</h2><p class="muted">只写入本机忽略的 .token 文件，不会回显、导出或提交到 Git。更换时输入新令牌即可。</p><label class="field"><span>GitHub Token · ${s.tokenPresent ? '已配置' : '未配置'}</span><input id="pub-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="粘贴新的 token（留空表示不更改）"></label><p><button class="btn" id="pub-token-save" type="button">保存认证令牌</button></p></section></div><section class="section"><span class="publish-step">03 / READINESS</span><h2>部署前置检查</h2><div class="status">${card(ok, '整体就绪')}${card(s.remoteOk, '目标仓库 ' + esc(s.allowedRemote))}${card(s.tokenPresent, '认证 token')}${card(s.systemProxyDetected ? '已接入' : '直连', 'GitHub 网络')}${card(s.workflowPresent, 'Actions Workflow')}${card('分支 ' + esc(s.branch), '当前分支')}${card(chg + ' 处变更', '工作区')}</div></section><section class="section"><h2>本次推送内容</h2><pre class="path">${esc(s.changes.map((x) => x.status.padEnd(3) + ' ' + x.path).join('\n') || '（工作区干净，无新增变更）')}</pre></section><section class="section"><span class="publish-step">04 / DEPLOY</span><h2>发布操作</h2><p class="muted">提交信息可选；留空使用默认信息。普通发布会先同步远程 main；强制替换只用于你明确要覆盖目标仓库时。</p><label class="field"><span>提交信息</span><input id="pub-msg" placeholder="e.g. chore: publish blog updates"></label><p><button class="btn primary" id="pub-go">发布</button> <button class="btn danger" id="pub-force">⚠ 首次上线（强制替换）</button></p><div class="publish-progress" id="pub-progress" role="status" aria-live="polite" aria-atomic="true" hidden><div class="publish-progress__head"><b id="pub-stage">正在准备发布</b><span id="pub-percent">0%</span></div><div class="publish-progress__track" id="pub-track" role="progressbar" aria-label="发布进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i class="publish-progress__bar" id="pub-bar"></i></div><p id="pub-detail">正在连接发布服务…</p></div><p class="muted">发布会自动沿用 Windows 系统代理，并推送到上方选定的仓库。</p></section>`;

  bindCommon();
  $('#pub-refresh').onclick = () => renderPublish({ page, bindCommon });
  $('#pub-target').closest('.section').querySelector('label.field').insertAdjacentHTML(
    'afterend',
    `<label class="field"><span>目标分支</span><input id="pub-branch" value="${esc(s.allowedBranch || 'main')}" autocomplete="off" spellcheck="false" placeholder="main"></label>`,
  );

  $('#pub-target-save').onclick = async () => {
    const remote = $('#pub-target').value.trim();
    const branch = $('#pub-branch').value.trim();
    if (!confirm(`将 LilyMap 发布目标改为 ${remote} 的 ${branch} 分支？`)) return;
    try {
      await api('/api/publish/target', { method: 'PUT', body: JSON.stringify({ remote, branch }) });
      toast('发布目标已保存到本机。');
      await renderPublish({ page, bindCommon });
    } catch (error) {
      toast(error.message);
    }
  };

  $('#pub-token-save').onclick = async () => {
    const token = $('#pub-token').value.trim();
    if (!token) return toast('请先输入新的认证令牌。');
    if (!confirm('替换本机的 GitHub 认证令牌？旧令牌将被覆盖。')) return;
    try {
      await api('/api/publish/token', { method: 'PUT', body: JSON.stringify({ token }) });
      $('#pub-token').value = '';
      toast('认证令牌已保存到本机。');
      await renderPublish({ page, bindCommon });
    } catch (error) {
      $('#pub-token').value = '';
      toast(error.message);
    }
  };

  const progressBox = $('#pub-progress');
  const setBusy = (busy) => {
    $('#pub-go').disabled = busy;
    $('#pub-force').disabled = busy;
    $('#pub-msg').disabled = busy;
    if (!busy) {
      $('#pub-force').dataset.armed = '';
      $('#pub-force').textContent = '⚠ 首次上线（强制替换）';
    }
  };

  const showProgress = (job) => {
    if (!job) return;
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    progressBox.hidden = false;
    progressBox.classList.toggle('is-complete', job.status === 'complete');
    progressBox.classList.toggle('is-failed', job.status === 'failed');
    $('#pub-stage').textContent = job.stage || '正在发布';
    $('#pub-percent').textContent = `${Math.round(progress)}%`;
    $('#pub-track').setAttribute('aria-valuenow', String(Math.round(progress)));
    $('#pub-bar').style.transform = `scaleX(${progress / 100})`;
    $('#pub-detail').textContent = job.status === 'failed'
      ? job.error || '发布未完成，请检查配置后重试。'
      : job.status === 'complete'
        ? `${job.message || '源码已推送。'} GitHub Actions 已接手线上构建。`
        : job.force
          ? '首次上线模式：完成前请不要关闭 LilyMap。'
          : `正在安全提交并同步 ${s.allowedBranch || 'main'} 分支，请不要重复点击。`;
  };

  const track = async (id) => {
    const tracker = ++publishTracker;
    while (tracker === publishTracker && state.view === 'publish') {
      try {
        const job = await api(`/api/publish/progress?id=${encodeURIComponent(id)}`, { silentProgress: true });
        showProgress(job);
        if (job.status !== 'running') {
          setBusy(false);
          toast(job.status === 'complete' ? '发布完成，GitHub Actions 正在构建。' : `发布失败：${job.error || '未知错误'}`);
          return;
        }
      } catch (error) {
        showProgress({
          status: 'failed',
          progress: Number($('#pub-track').getAttribute('aria-valuenow')),
          stage: '无法读取发布进度',
          error: error.message,
        });
        setBusy(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  };

  async function run(force) {
    const msg = $('#pub-msg').value.trim();
    if (force && !confirm('这会把线上 main 强制替换为当前 Hugo 源码。\n确定要继续吗？')) return;
    if (force && $('#pub-force').dataset.armed !== '1') {
      $('#pub-force').dataset.armed = '1';
      $('#pub-force').textContent = '再次点击确认强制替换';
      return;
    }
    setBusy(true);
    showProgress({ status: 'running', progress: 1, stage: '正在连接发布服务', force });
    try {
      const job = await api('/api/publish', {
        method: 'POST',
        body: JSON.stringify({ commit: msg, force }),
        silentProgress: true,
      });
      showProgress(job);
      void track(job.id);
    } catch (error) {
      showProgress({ status: 'failed', progress: 1, stage: '发布未能开始', error: error.message });
      setBusy(false);
      toast('发布失败：' + error.message);
    }
  }

  $('#pub-go').onclick = () => run(false);
  $('#pub-force').onclick = () => run(true);
  if (s.publishJob) {
    showProgress(s.publishJob);
    if (s.publishJob.status === 'running') {
      setBusy(true);
      void track(s.publishJob.id);
    }
  }
}
