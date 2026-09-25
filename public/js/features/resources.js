import { api, trackedFetch } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';

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
  const response = await api('/api/files');
  const bundles = {};
  for (const post of state.posts.filter((item) => item.kind === 'bundle')) bundles[post.directory] = post;

  const article = response.files.filter((file) =>
    Object.keys(bundles).some((directory) => file.path.startsWith(directory + '/') && !file.path.endsWith('/index.md')));
  const site = response.files.filter((file) => file.scope === 'public' && file.publicPath);
  const pipeline = response.files.filter((file) => file.scope === 'pipeline');

  const siteCards = site.map((file) =>
    `<div class="asset-card"><div class="asset-prev">${mediaPreview(file, file.publicPath)}</div><div class="asset-meta"><b>${esc(file.path.split('/').pop())}</b><span class="path" title="磁盘：${esc(file.path)}">公开：${esc(file.publicPath)}</span><small class="muted">${readableBytes(file.size)} · ${esc((file.extension || 'file').toUpperCase())}</small><div class="asset-actions"><button class="btn mini" data-copy="${esc(file.publicPath)}">复制公开路径</button>${file.path.startsWith('static/assets/') && ['image', 'video'].includes(file.kind) ? `<button class="btn mini" data-file-action="replace" data-file-path="${esc(file.path)}">替换</button><button class="btn mini" data-file-action="rename" data-file-path="${esc(file.path)}">重命名</button><button class="btn mini danger" data-file-action="delete" data-file-path="${esc(file.path)}">删除</button>` : ''}</div></div></div>`
  ).join('') || '<div class="empty">暂无站点资源。</div>';

  $('#main').innerHTML =
    page('资源', '站点资源只写入 static/assets，并自动换算为稳定的 /assets/... 公开路径。') +
    `<section class="section"><div class="security-note"><span aria-hidden="true">✓</span><p><strong>路径规则已统一</strong>磁盘位置是 static/assets/...；Hugo 与线上使用 /assets/...。源码管线 assets/ 不再伪装成可直接访问 URL。</p></div><h2>站点资源</h2><p class="muted">可以上传、替换、重命名或移入回收区。重命名及删除前请检查文章和配置中的引用。</p><label class="upload-btn btn primary">+ 上传图片<input id="res-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden></label><div class="asset-grid">${siteCards}</div></section>${pipeline.length ? `<section class="section"><h2>Hugo 资源管线（不直接公开）</h2><div class="security-note"><span aria-hidden="true">i</span><p><strong>${pipeline.length} 个 assets/ 源文件</strong>这些文件需要模板处理后才有 URL，LilyMap 不再生成误导性的公开路径。</p></div></section>` : ''}<section class="section"><h2>文章图片</h2>${article.length ? `<div class="asset-grid">${article.map((file) => `<div class="asset-card"><div class="asset-prev">${mediaPreview(file, '/' + file.path)}</div><div class="asset-meta"><b>${esc(file.path.split('/').pop())}</b><span class="path">${esc(Object.entries(bundles).find(([directory]) => file.path.startsWith(directory + '/'))?.[1]?.title || file.path)}</span><div class="asset-actions"><button class="btn mini" data-copy="${esc(file.path.split('/').pop())}">复制文件名</button>${file.kind === 'image' ? `<button class="btn mini" data-file-action="replace" data-file-path="${esc(file.path)}">替换</button><button class="btn mini" data-file-action="rename" data-file-path="${esc(file.path)}">重命名</button><button class="btn mini danger" data-file-action="delete" data-file-path="${esc(file.path)}">删除</button>` : ''}</div></div></div>`).join('')}</div>` : '<div class="empty">尚未发现 Page Bundle 图片。</div>'}</section>`;

  bindCommon();

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
              await renderResources({ page, bindCommon });
            } catch (error) {
              toast(error.message);
            }
          };
          chooser.click();
          return;
        }
        toast('资源操作已完成。');
        await renderResources({ page, bindCommon });
      } catch (error) {
        toast(error.message);
      }
    };
  });

  const upload = $('#res-upload');
  upload.onchange = async () => {
    let ok = 0;
    let fail = 0;
    await Promise.all([...upload.files].map(async (file) => {
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
    }));
    toast(`上传完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`);
    await renderResources({ page, bindCommon });
  };
}
