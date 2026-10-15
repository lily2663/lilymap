import { api, trackedFetch } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { mountImageOptimization } from './image-optimization.js';

let resourceRevision = 0;

function readableBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function mediaPreview(file, source) {
  if (file.kind === 'image') return `<img src="${esc(source)}" alt="" loading="lazy" decoding="async">`;
  if (file.kind === 'video') return `<video src="${esc(source)}" muted loop playsinline preload="metadata"></video>`;
  return `<div class="file-badge">${esc(file.extension || 'file')}</div>`;
}

export async function renderResources({ page, bindCommon }) {
  const revision = ++resourceRevision;
  const viewCurrent = () => state.view === 'resources' && revision === resourceRevision;
  let response;
  try { response = await api('/api/files'); }
  catch (error) {
    if (!viewCurrent()) return;
    $('#main').innerHTML = page('资源', '资源列表暂时无法加载。') + `<div class="empty">${esc(error.message)}<p><button class="btn" id="resources-retry">重试</button></p></div>`;
    $('#resources-retry').onclick = () => { void renderResources({ page, bindCommon }); };
    bindCommon();
    return;
  }
  if (!viewCurrent()) return;
  const bundles = {};
  for (const post of state.posts.filter((item) => item.kind === 'bundle')) bundles[post.directory] = post;

  const article = response.files.filter((file) =>
    Object.keys(bundles).some((directory) => file.path.startsWith(directory + '/') && !file.path.endsWith('/index.md')));
  const generated = response.files.filter((file) => file.generated || file.path.startsWith('static/assets/img/responsive/'));
  const generatedPaths = new Set(generated.map((file) => file.path));
  const site = response.files.filter((file) => file.scope === 'public' && file.publicPath && !generatedPaths.has(file.path));
  const pipeline = response.files.filter((file) => file.scope === 'pipeline');
  const catalog = [...site.map((file) => ({ ...file, area: 'site' })), ...article.map((file) => ({ ...file, area: 'article' }))];
  let limit = 24;
  $('#main').innerHTML =
    page('资源', '站点资源只写入 static/assets，并自动换算为稳定的 /assets/... 公开路径。') +
    `<section class="section" id="image-optimization"></section><section class="section" id="resource-library"><h2>资源库</h2><p class="muted">上传、替换、重命名或移入回收区。修改前请检查文章和配置中的引用。${generated.length ? ` ${generated.length} 个自动生成的尺寸版本已收起，由图片优化统一维护。` : ''}</p><label class="upload-btn btn primary">+ 上传图片<input id="res-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden></label><div class="toolbar resource-filters"><input id="resource-search" type="search" aria-label="搜索资源" placeholder="搜索文件名、路径或文章标题"><select id="resource-scope" aria-label="资源范围"><option value="all">全部资源</option><option value="site">站点资源</option><option value="article">文章图片</option></select></div><p id="resource-count" class="muted" role="status"></p><div class="asset-grid" id="resource-grid"></div><p><button class="btn" id="resource-more" type="button">显示更多</button></p></section>${pipeline.length ? `<section class="section"><h2>Hugo 资源管线（不直接公开）</h2><p class="muted">${pipeline.length} 个 assets/ 源文件需要模板处理后才有公开 URL。</p></section>` : ''}`;
  const library = $('#resource-library');
  const current = () => viewCurrent() && library.isConnected;
  bindCommon();
  void mountImageOptimization($('#image-optimization'), current);

  function titleFor(file) {
    return file.area === 'article' ? Object.entries(bundles).find(([directory]) => file.path.startsWith(directory + '/'))?.[1]?.title || '' : '';
  }
  function drawCards() {
    const query = $('#resource-search').value.trim().toLocaleLowerCase();
    const scope = $('#resource-scope').value;
    const matches = catalog.filter((file) => (scope === 'all' || file.area === scope) && `${file.path} ${titleFor(file)}`.toLocaleLowerCase().includes(query));
    $('#resource-count').textContent = `共 ${matches.length} 个匹配资源，已显示 ${Math.min(limit, matches.length)} 个。`;
    $('#resource-more').hidden = matches.length <= limit;
    $('#resource-grid').innerHTML = matches.slice(0, limit).map((file) => {
      const source = file.publicPath || '/' + file.path;
      const managed = file.area === 'article' ? file.kind === 'image' : file.path.startsWith('static/assets/') && ['image', 'video'].includes(file.kind);
      return `<div class="asset-card"><div class="asset-prev">${mediaPreview(file, source)}</div><div class="asset-meta"><b>${esc(file.path.split('/').pop())}</b>${titleFor(file) ? `<small>${esc(titleFor(file))}</small>` : ''}<span class="path" title="${esc(file.path)}">${esc(file.publicPath || file.path)}</span><small class="muted">${readableBytes(file.size)} · ${esc((file.extension || 'file').toUpperCase())}</small><div class="asset-actions"><button class="btn mini" data-copy="${esc(file.publicPath || file.path.split('/').pop())}">${file.publicPath ? '复制公开路径' : '复制文件名'}</button>${managed ? `<button class="btn mini" data-file-action="replace" data-file-path="${esc(file.path)}">替换</button><button class="btn mini" data-file-action="rename" data-file-path="${esc(file.path)}">重命名</button><button class="btn mini danger" data-file-action="delete" data-file-path="${esc(file.path)}">删除</button>` : ''}</div></div></div>`;
    }).join('') || '<div class="empty">没有匹配资源，请调整搜索条件。</div>';
    bindResourceActions();
  }
  $('#resource-search').oninput = () => { limit = 24; drawCards(); };
  $('#resource-scope').onchange = () => { limit = 24; drawCards(); };
  $('#resource-more').onclick = () => { limit += 24; drawCards(); };

  function bindResourceActions() {
  document.querySelectorAll('.asset-prev video').forEach((video) => {
    video.addEventListener('pointerenter', () => { void video.play().catch(() => {}); });
    video.addEventListener('pointerleave', () => video.pause());
  });

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.onclick = () => navigator.clipboard.writeText(button.dataset.copy)
      .then(() => toast('已复制：' + button.dataset.copy))
      .catch(() => toast('复制失败'));
  });

  document.querySelectorAll('[data-file-action]').forEach((button) => {
    button.onclick = async () => {
      const filePath = button.dataset.filePath;
      const action = button.dataset.fileAction;
      try {
        if (action === 'rename') {
          const currentName = filePath.split('/').pop();
          const name = window.prompt('新文件名（扩展名保持不变）。引用旧路径的文章或配置需要手动更新。', currentName);
          if (!name || name === currentName) return;
          await api(`/api/file?path=${encodeURIComponent(filePath)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        } else if (action === 'delete') {
          if (!confirm(`将 ${filePath} 移入回收区？引用它的页面可能需要更新。`)) return;
          await api(`/api/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
        } else {
          const chooser = document.createElement('input');
          chooser.type = 'file';
          chooser.accept = filePath.endsWith('.mp4') ? 'video/mp4' : 'image/*';
          chooser.onchange = async () => {
            const file = chooser.files?.[0];
            if (!file) return;
            if (file.name.split('.').pop().toLowerCase() !== filePath.split('.').pop().toLowerCase()) {
              toast('替换文件需要保持原扩展名。');
              return;
            }
            try {
              const response = await trackedFetch(
                `/api/file?path=${encodeURIComponent(filePath)}`,
                { method: 'PUT', body: file },
                '正在替换资源',
              );
              if (!response.ok) throw Error((await response.json()).error || '替换失败');
              toast('资源已替换，旧文件留在回收区。');
              if (current()) await renderResources({ page, bindCommon });
            } catch (error) {
              toast(error.message);
            }
          };
          chooser.click();
          return;
        }
        toast('资源操作已完成。');
        if (current()) await renderResources({ page, bindCommon });
      } catch (error) {
        toast(error.message);
      }
    };
  });
  }
  drawCards();

  const upload = $('#res-upload');
  upload.onchange = async () => {
    let ok = 0;
    let fail = 0;
    const pending = [...upload.files];
    upload.disabled = true;
    const worker = async () => {
      for (let file; (file = pending.shift());) {
      try {
        const response = await trackedFetch(
          '/api/asset/upload?name=' + encodeURIComponent(file.name) + '&area=static/assets/img',
          { method: 'POST', headers: { 'content-type': file.type }, body: file },
          `正在上传 ${file.name}`,
        );
        if (response.ok) ok += 1;
        else fail += 1;
      } catch {
        fail += 1;
      }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    toast(`上传完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`);
    if (current()) await renderResources({ page, bindCommon });
  };
}
