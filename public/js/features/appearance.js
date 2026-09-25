import { api, beginOperation, endOperation, trackedFetch } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';

function isVideoPath(value) {
  return /\.(mp4|webm)(?:[?#].*)?$/i.test(String(value || ''));
}

function appearanceMediaMarkup(source) {
  if (!source) return '<div class="file-badge" style="height:220px">未设置媒体</div>';
  if (isVideoPath(source)) {
    return `<video src="${esc(source)}" poster="${esc(source.replace(/\.(mp4|webm)$/i, '.poster.webp'))}" muted loop playsinline controls preload="metadata"></video>`;
  }
  return `<img src="${esc(source)}" alt="">`;
}

function setAppearanceMedia(target, source) {
  const key = target === 'welcome' ? 'curW' : target === 'night' ? 'curN' : 'curA';
  state.appr[key] = source;
  const preview = document.querySelector(`.appr-preview[data-target="${target}"]`);
  preview?.querySelector('img,video,.file-badge')?.remove();
  preview?.insertAdjacentHTML('afterbegin', appearanceMediaMarkup(source));
  const current = document.querySelector(`[data-current="${target}"]`);
  if (current) {
    current.textContent = source;
    current.title = source;
  }
  const type = document.querySelector(`[data-media-type="${target}"]`);
  if (type) type.textContent = isVideoPath(source) ? '动态视频' : '静态图片';
  state.appr.dirty = true;
  if ($('#appr-save')) $('#appr-save').textContent = '保存并应用 · 有修改';
}

function readableBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

async function importMediaPath(target) {
  const input = $('#media-local-path');
  const stateNode = $('#media-import-state');
  const sourcePath = input?.value.trim();
  if (!sourcePath) return toast('请先粘贴完整的本机文件路径。');
  const buttons = [...document.querySelectorAll('[data-media-import]')];
  buttons.forEach((button) => { button.disabled = true; });
  stateNode.textContent = '正在检查文件并优化媒体；4K 视频通常需要几十秒…';

  try {
    const result = await api('/api/media/import', {
      method: 'POST',
      body: JSON.stringify({ sourcePath, target }),
    });
    setAppearanceMedia(target, result.path);
    const saving = result.sourceSize > 0 ? Math.max(0, Math.round((1 - result.outputSize / result.sourceSize) * 100)) : 0;
    stateNode.textContent = `${result.kind === 'video' ? '视频已转为 1080p H.264 MP4' : '图片已复制'}：${readableBytes(result.sourceSize)} → ${readableBytes(result.outputSize)}${saving ? `（-${saving}%）` : ''}。点击“应用外观”写入配置。`;
    toast('媒体导入完成；点击“应用外观”生效。');
  } catch (error) {
    const message = /未知 API|Unknown API/i.test(error.message)
      ? '当前是旧版 LilyMap 后端。请关闭 LilyMap 终端并重新运行 npm run admin，然后再导入。'
      : error.message;
    stateNode.textContent = message;
    toast(message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function optimizeAppearanceImage(file, target) {
  const settings = state.settings?.values || {};
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  if (settings['params.performance.optimizeUploads'] === false || isGif) {
    return { body: file, name: file.name, before: file.size, after: file.size, optimized: false };
  }

  const preset = settings['params.performance.imageQuality'] || 'high';
  const profiles = {
    compact: { maxEdge: 1920, quality: 0.74 },
    high: { maxEdge: 2560, quality: 0.82 },
    ultra: { maxEdge: 3200, quality: 0.9 },
  };
  let profile = profiles[preset] || profiles.high;
  if (target === 'avatar') profile = { ...profile, maxEdge: Math.min(profile.maxEdge, 768) };

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { body: file, name: file.name, before: file.size, after: file.size, optimized: false };
  }

  const scale = Math.min(1, profile.maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { alpha: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', profile.quality));
  if (!blob) throw new Error('浏览器无法生成 WebP，请换用 PNG 或 JPG 后重试。');

  const useOptimized = blob.size <= file.size * 1.05;
  const body = useOptimized ? blob : file;
  const extension = useOptimized ? 'webp' : (file.name.split('.').pop() || 'png').toLowerCase();
  return {
    body,
    name: `${target}-${Date.now()}.${extension}`,
    before: file.size,
    after: body.size,
    optimized: useOptimized,
    dimensions: `${canvas.width}×${canvas.height}`,
  };
}

async function uploadAsset(event, target) {
  const file = event.target.files[0];
  if (!file) return;
  const mediaOperation = beginOperation('正在准备媒体文件');
  try {
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(file.name);
    if (isVideo) {
      if (target === 'avatar') throw new Error('头像只支持图片；动态壁纸请上传到日间或夜间。');
      if (file.size > 160 * 1024 * 1024) throw new Error('视频超过 160 MB，请改用下方“从本机完整路径导入”。');
      toast('正在上传并转换视频，请保持 LilyMap 页面打开…');
      const response = await trackedFetch(
        '/api/media/upload?name=' + encodeURIComponent(file.name) + '&target=' + encodeURIComponent(target),
        { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file },
        '正在上传并转换视频',
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '视频上传失败。');
      setAppearanceMedia(target, result.path);
      const saving = result.sourceSize > 0 ? Math.max(0, Math.round((1 - result.outputSize / result.sourceSize) * 100)) : 0;
      toast(`视频已优化 ${readableBytes(result.sourceSize)} → ${readableBytes(result.outputSize)}${saving ? `（-${saving}%）` : ''}；点击“应用外观”生效。`);
      return;
    }

    toast(/\.gif$/i.test(file.name) || file.type === 'image/gif' ? '正在读取 GIF，动画帧会原样保留…' : '正在本机优化图片…');
    const prepared = await optimizeAppearanceImage(file, target);
    const area = prepared.optimized
      ? `static/assets/img/optimized/${target === 'avatar' ? 'avatars' : 'wallpapers'}`
      : 'static/assets/img';
    const response = await trackedFetch(
      '/api/asset/upload?name=' + encodeURIComponent(prepared.name) + '&area=' + encodeURIComponent(area),
      { method: 'POST', headers: { 'content-type': prepared.body.type || file.type }, body: prepared.body },
      '正在上传优化后的图片',
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '上传失败。');
    setAppearanceMedia(target, result.path);
    const saving = prepared.before > 0 ? Math.max(0, Math.round((1 - prepared.after / prepared.before) * 100)) : 0;
    toast(prepared.optimized
      ? `已优化 ${readableBytes(prepared.before)} → ${readableBytes(prepared.after)}（-${saving}% · ${prepared.dimensions}）；点击「应用外观」生效。`
      : `已上传 ${file.name}；点击「应用外观」生效。`);
  } catch (error) {
    const message = /未知 API|Unknown API/i.test(error.message || '')
      ? '当前是旧版 LilyMap 后端。请关闭 LilyMap 终端并重新运行 npm run admin。'
      : error.message || '媒体处理失败。';
    toast(message);
  } finally {
    endOperation(mediaOperation);
    event.target.value = '';
  }
}

export async function renderAppearance({ page, bindCommon }) {
  const [settingsResponse, fileResponse] = await Promise.all([api('/api/settings'), api('/api/files')]);
  state.settings = settingsResponse;
  const files = fileResponse.files.filter((file) => file.publicPath && ['image', 'video'].includes(file.kind));
  const assets = files.map((file) => file.publicPath);
  const values = settingsResponse.values || {};
  const optimizeUploads = values['params.performance.optimizeUploads'] !== false;
  const imageQuality = values['params.performance.imageQuality'] || 'high';
  const qualityNames = { compact: '轻量', high: '高清', ultra: '超清' };
  const curW = values['params.welcome.background']
    || values['welcome.background']
    || values['welcome.bg']
    || assets.find((item) => /welcome.*(day|light)|welcome-watercolor|background(?!Dark)/i.test(item))
    || '';
  const curN = values['params.welcome.backgroundDark']
    || values['welcome.backgroundDark']
    || assets.find((item) => /night|dark/i.test(item))
    || '';
  const curA = values['params.avatar']
    || values.avatar
    || assets.find((item) => /avatar|author|profile/i.test(item))
    || '';
  state.appr = { files, curW, curN, curA, dirty: false };

  const card = (id, label, caption) => {
    const key = id === 'welcome' ? 'curW' : id === 'night' ? 'curN' : 'curA';
    const current = state.appr[key];
    const accept = id === 'avatar'
      ? 'image/png,image/jpeg,image/webp,image/gif,image/avif'
      : 'image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime,.m4v,.mkv,.avi';
    return `<article class="appearance-card"><header class="appearance-card__head"><div><b>${label}</b><small>${caption}</small></div><span class="appearance-card__type" data-media-type="${id}">${current ? (isVideoPath(current) ? '动态视频' : '静态图片') : '未设置'}</span></header><div class="appr-preview" data-target="${id}">${appearanceMediaMarkup(current)}<figcaption>${label}</figcaption></div><div class="appearance-card__body"><div class="appearance-card__actions"><label class="btn primary" for="appr-${id}">${current ? '更换媒体' : '选择媒体'}</label><span class="muted">${id === 'avatar' ? 'PNG / JPG / WebP / GIF / AVIF' : '图片或视频'}</span><input type="file" id="appr-${id}" accept="${accept}" hidden></div><code class="appearance-card__path" data-current="${id}" title="${esc(current || '未设置')}">${esc(current || '未设置')}</code></div></article>`;
  };

  $('#main').innerHTML =
    page(
      '外观',
      '集中管理全站壁纸与头像；选择、预览、应用三步完成。',
      '<button class="btn primary" id="appr-save" type="button">保存并应用</button>',
    ) +
    `<div class="appearance-workflow" aria-label="外观设置流程"><div><i>1</i><span><b>选择</b><small>上传文件或粘贴路径</small></span></div><div><i>2</i><span><b>预览</b><small>确认日间与夜间效果</small></span></div><div><i>3</i><span><b>应用</b><small>一次保存到博客配置</small></span></div></div><div class="security-note"><span aria-hidden="true">${optimizeUploads ? '✓' : 'i'}</span><p><strong>${optimizeUploads ? `本机优化已开启 · 图片${qualityNames[imageQuality] || '高清'} / 视频 1080p` : '自动图片优化已关闭'}</strong>图片在浏览器本机压缩；视频由 FFmpeg 转为 H.264 MP4、30fps 并保留比例，所有处理均留在这台电脑。</p></div><section class="section"><div class="section-heading"><div><h2>主题背景</h2><p class="muted">欢迎页和博客内页共用下面这组日间/夜间媒体。</p></div></div><div class="appearance-grid">${card('welcome', '日间壁纸', '浅色主题')}${card('night', '夜间壁纸', '深色主题')}</div></section><section class="section feature-card"><div class="feature-card__intro"><span class="feature-card__icon" aria-hidden="true">⌁</span><div><h2>从本机路径快速导入</h2><p>适合视频和大文件：跳过浏览器上传，直接读取本机文件并生成网页版本。</p></div></div><div class="media-import"><label class="field"><span>文件完整路径</span><input id="media-local-path" spellcheck="false" placeholder="D:\\Wallpapers\\scene.mp4"><small class="muted">支持 PNG / JPG / WebP / GIF / AVIF / MP4 / WebM / MOV / M4V / MKV / AVI。</small></label><div><button class="btn primary" data-media-import="welcome">导入到日间</button> <button class="btn" data-media-import="night">导入到夜间</button></div><p class="media-import__state" id="media-import-state">导入完成后会先进入上方预览，最后点击“保存并应用”。</p></div></section><section class="section"><div class="section-heading"><div><h2>站点身份</h2><p class="muted">头像用于作者卡片和个人信息模块。</p></div></div><div class="appearance-avatar">${card('avatar', '作者头像', '侧边作者卡片')}</div></section>`;

  bindCommon();
  $('#appr-welcome').onchange = (event) => uploadAsset(event, 'welcome');
  $('#appr-night').onchange = (event) => uploadAsset(event, 'night');
  $('#appr-avatar').onchange = (event) => uploadAsset(event, 'avatar');
  document.querySelectorAll('[data-media-import]').forEach((button) => {
    button.onclick = () => importMediaPath(button.dataset.mediaImport);
  });

  $('#appr-save').onclick = async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          values: {
            'params.welcome.background': state.appr.curW,
            'params.welcome.backgroundDark': state.appr.curN,
            'params.avatar': state.appr.curA,
          },
        }),
      });
      state.appr.dirty = false;
      $('#appr-save').textContent = '已应用';
      setTimeout(() => {
        if ($('#appr-save')) $('#appr-save').textContent = '保存并应用';
      }, 1200);
      toast('外观已应用，欢迎页与内页背景已更新。');
    } catch (error) {
      toast(error.message);
    }
  };
}
