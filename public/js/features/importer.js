import { api, beginOperation, endOperation, updateOperation } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';

async function asBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

async function walkDropEntry(entry, prefix, output) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    output.push({ file, relativePath: prefix + entry.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  let batch;
  do {
    batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    for (const child of batch) await walkDropEntry(child, prefix + entry.name + '/', output);
  } while (batch.length);
}

async function collectDropFiles(dataTransfer) {
  const output = [];
  const entries = [...(dataTransfer.items || [])]
    .map((item) => {
      try { return item.webkitGetAsEntry?.() || null; }
      catch { return null; }
    })
    .filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await walkDropEntry(entry, '', output);
    if (output.length) return output;
  }
  return [...dataTransfer.files].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

export function createImportFeature({ page, bindCommon, setView, refresh, openArticle }) {
  async function readFiles(files) {
    const operation = beginOperation(`正在读取文件 0/${files.length}`);
    try {
      const payload = [];
      for (const entry of files) {
        const file = entry.file || entry;
        payload.push({
          name: file.name,
          relativePath: entry.relativePath || file.webkitRelativePath || file.name,
          type: file.type,
          content: await asBase64(file),
        });
        updateOperation(operation, `正在读取文件 ${payload.length}/${files.length}`);
      }
      state.import = { payload };
      await inspect();
    } catch (error) {
      toast(error.message);
    } finally {
      endOperation(operation);
    }
  }

  async function inspect() {
    try {
      const payload = state.import?.payload || [];
      const plan = await api('/api/import/inspect', {
        method: 'POST',
        body: JSON.stringify({ files: payload }),
      });
      if (!state.import) state.import = { payload };
      state.import.plan = plan;
      const missing = plan.missing || [];
      const missingMarkup = missing.map((item) => esc(item)).join('<br>');

      $('#plan').innerHTML =
        `<div class="import-plan"><h2>确认导入</h2><div class="kv"><span>标题</span><b>${esc(plan.title)}</b></div><div class="kv"><span>目标路径</span><b class="path">content/posts/${esc(plan.slug)}/index.md</b></div><div class="kv"><span>Front Matter</span><b>${plan.hasFrontMatter ? '已识别，保持原样' : '未发现，将补充最小 Hugo Front Matter'}</b></div><div class="kv"><span>关联资源</span><b>${plan.assetCount} 个${missing.length ? `；<span style="color:var(--danger)">缺少 ${missing.length} 张图片</span>` : ''}</b></div>${plan.rewriteCount ? `<div class="kv"><span>本地图片引用</span><b>自动改写 ${plan.rewriteCount} 处为博客路径</b></div>` : ''}${missing.length ? `<div class="kv"><span>缺失图片</span><b class="path" style="color:var(--danger)">${missingMarkup}</b></div><p><label class="btn primary" style="display:inline-block">补选缺失图片（可多选）<input id="missing-pick" type="file" accept="image/*" multiple hidden></label> <span class="muted">按文件名自动匹配归位，选完自动重新检查</span></p>` : ''}<label class="switch"><span><b>发布为草稿</b><p>没有 Front Matter 时默认安全导入为草稿</p></span><input id="import-draft" type="checkbox" checked></label><p><button class="btn primary" id="confirm-import">导入</button> <button class="btn" id="cancel-import">取消</button></p></div>`;

      const picker = $('#missing-pick');
      if (picker) {
        picker.onchange = async (event) => {
          const extra = [...event.target.files];
          if (!extra.length) return;
          for (const file of extra) {
            state.import.payload.push({
              name: file.name,
              relativePath: file.name,
              type: file.type,
              content: await asBase64(file),
            });
          }
          toast(`已补选 ${extra.length} 张图片，重新检查引用…`);
          await inspect();
        };
      }

      $('#confirm-import').onclick = async () => {
        try {
          const result = await api('/api/import', {
            method: 'POST',
            body: JSON.stringify({
              files: payload,
              draft: $('#import-draft').checked,
            }),
          });
          toast(`已导入 ${result.path}${result.assetCount ? `（含 ${result.assetCount} 张图片）` : ''}`);
          await refresh();
          setView('articles');
          void openArticle(result.path);
        } catch (error) {
          toast(error.message);
        }
      };
      $('#cancel-import').onclick = () => {
        $('#plan').innerHTML = '';
        state.import = null;
      };
    } catch (error) {
      toast(error.message);
    }
  }

  function render() {
    $('#main').innerHTML =
      page(
        '导入 Typora Markdown',
        '拖入 .md 与其图片目录（可一起拖入整个文章文件夹），或点击下方按钮选择；正文保持原样。',
      ) +
      '<section id="drop" class="drop"><h2>拖入 Markdown / 文章目录 / 图片</h2><p>自动读取 Front Matter、识别图片引用并归位到 Page Bundle。</p><button class="btn primary" id="choose-md">选择 Markdown 与图片</button> <button class="btn" id="choose-folder">选择文章目录</button></section><div id="plan"></div>';

    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove('over');
    }));
    drop.addEventListener('drop', async (event) => {
      const items = await collectDropFiles(event.dataTransfer);
      await readFiles(items);
    });
    $('#choose-md').onclick = () => $('#file-picker').click();
    $('#choose-folder').onclick = () => $('#folder-picker').click();
    bindCommon();
  }

  return { render, readFiles };
}
