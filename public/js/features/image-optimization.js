import { api } from '../core/api.js';
import { esc } from '../core/dom.js';

export async function mountImageOptimization(container, isCurrent) {
  let model = null;
  let starting = false;
  let uncertain = false;
  let message = '';
  let failures = 0;
  let timer;
  let requestRevision = 0;
  const current = () => container.isConnected && isCurrent();

  function draw() {
    if (!current()) return;
    const manifest = model?.manifest;
    const task = model?.task;
    const busy = starting || uncertain || task?.status === 'running';
    const status = starting ? '正在启动图片优化…'
      : uncertain ? '暂时无法确认任务状态，请刷新状态。'
        : task?.status === 'running' ? '正在生成图片尺寸版本，完成后会更新本地预览。'
          : task?.status === 'success' ? task.warning ? '响应式图片已更新。' : '响应式图片已更新，本地预览已安排重建。'
            : task?.status === 'error' ? task.error || '图片优化失败，请查看日志。' : '';
    container.innerHTML = `<h2>文章图片优化</h2><p class="muted">为已发布文章生成适合不同屏幕的 WebP 尺寸版本，保留原图与文章内容。</p>
      ${manifest ? `<p>已验证 <strong>${manifest.validImages}</strong> 个图片来源、<strong>${manifest.validCandidates}</strong> 个尺寸版本。${manifest.invalidImages || manifest.invalidCandidates ? `<span class="resource-warning">发现 ${manifest.invalidImages} 个来源或 ${manifest.invalidCandidates} 个尺寸版本需要重新生成。</span>` : ''}</p>` : ''}
      ${manifest?.reason ? `<p class="muted">${esc(manifest.reason)}</p>` : ''}
      ${model && !model.supported ? `<p class="muted">${esc(model.reason)}</p>` : ''}
      <div class="asset-actions"><button class="btn primary" type="button" data-optimize ${!model?.supported || busy ? 'disabled' : ''}>${busy ? '正在处理' : '生成响应式图片'}</button><button class="btn" type="button" data-optimize-refresh ${starting ? 'disabled' : ''}>刷新状态</button></div>
      <p role="status" aria-live="polite">${esc(message || status)}</p>
      ${task?.warning ? `<p class="resource-warning" role="alert">${esc(task.warning)}</p>` : ''}
      ${task?.output ? `<details><summary>查看最近任务日志</summary><pre class="optimization-log">${esc(task.output)}</pre></details>` : ''}`;
    container.querySelector('[data-optimize]').onclick = start;
    container.querySelector('[data-optimize-refresh]').onclick = () => { void load(); };
  }

  function schedule() {
    clearTimeout(timer);
    if (current() && (model?.task?.status === 'running' || uncertain) && failures < 3) {
      timer = setTimeout(() => { void load(); }, 1500);
    }
  }

  async function load() {
    clearTimeout(timer);
    const revision = ++requestRevision;
    try {
      const result = await api('/api/images/optimization', { silentProgress: true });
      if (!current() || revision !== requestRevision) return;
      model = result;
      uncertain = false;
      failures = 0;
      message = '';
    } catch (error) {
      if (!current() || revision !== requestRevision) return;
      failures += 1;
      if (model?.task?.status === 'running' || uncertain) uncertain = true;
      message = `无法读取图片优化状态：${error.message}${uncertain ? '。任务可能仍在继续，请刷新状态确认。' : ''}`;
    }
    draw();
    schedule();
  }

  async function start() {
    if (starting || uncertain || !model?.supported || model.task?.status === 'running') return;
    clearTimeout(timer);
    const revision = ++requestRevision;
    starting = true;
    message = '';
    draw();
    try {
      const result = await api('/api/images/optimization', { method: 'POST', body: '{}', progressLabel: '正在启动图片优化' });
      if (!current() || revision !== requestRevision) return;
      model = result;
      failures = 0;
    } catch (error) {
      if (!current() || revision !== requestRevision) return;
      uncertain = true;
      message = `未能确认启动结果：${error.message}。正在重新读取状态，请勿重复启动。`;
    } finally {
      starting = false;
    }
    draw();
    schedule();
  }

  draw();
  await load();
}
