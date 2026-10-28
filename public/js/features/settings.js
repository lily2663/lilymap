import { api, ApiError } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { sameValue, selectOptionIndex, selectOptionLabel, selectOptionValue } from '../core/value.js';

let settingsRevision = 0;

const MENU_KEYS = ['name', 'url', 'weight'];

// 字段值与“未设置”必须区分：undefined 表示配置里没有这个键，
// 空字符串 / false / 0 都是用户显式设置的值，不能被 truthy fallback 抹掉。
function controlValue(field, values) {
  return Object.hasOwn(values, field.path) ? values[field.path] : field.default;
}

// 主题 schema 由另一个仓库（themes/）维护，字段可能还没声明。
// 这里记录"主题已声明、LilyMap 也能安全编辑"的路径所对应的补充帮助文案；
// 如果 schema 里没有该字段，UI 只是不渲染它，绝不报错、绝不硬编码字段清单。
// 渲染顺序、分组、标签、类型仍然全部来自 schema。
const FIELD_HELP_OVERRIDES = {
  'params.shareImage': '站点默认分享图（1200×630 PNG/JPG）：未给文章单独设置 shareImage 时使用；留空则回退头像。',
  'params.rss.updated': '仅在 RSS 模板或摘要策略真实变更时手动更新一次（RFC3339，如 2026-10-29T01:00:00+08:00）；普通保存设置或重建站点不要改它。',
};

function fieldHelp(field) {
  if (Object.hasOwn(FIELD_HELP_OVERRIDES, field.path)) return FIELD_HELP_OVERRIDES[field.path];
  return field.help || field.path;
}

// schema 自检：缺 sections / 字段类型不认识时降级成空列表而不是抛错，
// 这样即使主题 schema 是旧版本，设置页其余部分仍然可用。
function safeSchema(schema) {
  if (!schema || typeof schema !== 'object' || !Array.isArray(schema.sections)) return { sections: [] };
  const sections = schema.sections
    .filter((section) => section && typeof section === 'object' && Array.isArray(section.fields))
    .map((section) => ({
      ...section,
      fields: section.fields.filter((field) => field && typeof field === 'object' && typeof field.path === 'string' && field.path),
    }));
  return { ...schema, sections };
}

function settingField(field, values, mode) {
  const value = controlValue(field, values);
  const help = fieldHelp(field);
  const blocked = mode && mode.editable === false;
  const lockNote = blocked
    ? '<small class="muted">该字段在当前 hugo.toml 中的写法无法安全地可视化编辑，请使用下方“高级配置”修改原文。</small>'
    : '';
  if (field.type === 'boolean') {
    return `<label class="switch${blocked ? ' is-locked' : ''}"><span><b>${esc(field.label)}</b><p>${esc(help)}</p></span><input data-config="${field.path}" type="checkbox" ${value ? 'checked' : ''} ${blocked ? 'disabled' : ''}>${lockNote}</label>`;
  }
  if (field.type === 'select') {
    const selected = selectOptionIndex(field, value);
    return `<label class="field${blocked ? ' is-locked' : ''}"><span>${esc(field.label)}</span><select data-config="${field.path}" ${blocked ? 'disabled' : ''}>${(field.options || []).map((option, index) => `<option value="${index}" ${index === selected ? 'selected' : ''}>${esc(selectOptionLabel(option))}</option>`).join('')}</select><small class="muted">${esc(help)}</small>${lockNote}</label>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'color' ? 'color' : field.type === 'url' ? 'url' : 'text';
  const limits = field.type === 'number'
    ? ['min', 'max', 'step'].filter((key) => Object.hasOwn(field, key)).map((key) => `${key}="${esc(field[key])}"`).join(' ')
    : '';
  const text = value === undefined || value === null ? '' : value;
  return `<label class="field${blocked ? ' is-locked' : ''}"><span>${esc(field.label)}</span><input data-config="${field.path}" type="${type}" value="${esc(text)}" ${limits} ${blocked ? 'disabled' : ''}><small class="muted">${esc(help)}</small>${lockNote}</label>`;
}

function menuMarkup(menu = { name: '新菜单', url: '/', weight: 60 }) {
  const extras = Object.keys(menu).filter((key) => !MENU_KEYS.includes(key));
  const extraNote = extras.length
    ? `<small class="muted">该菜单项还含 ${extras.map((key) => esc(key)).join('、')} 字段，保存时原样保留。</small>`
    : '';
  return `<div class="menu-item"><input data-menu="name" value="${esc(menu.name)}"><input data-menu="url" value="${esc(menu.url)}"><input data-menu="weight" type="number" value="${esc(menu.weight)}"><button class="btn" type="button">删除</button>${extraNote}</div>`;
}

function bindMenuDeletes() {
  document.querySelectorAll('.menu-item button').forEach((button) => {
    button.onclick = () => button.parentElement.remove();
  });
}

function readMenuInputs() {
  return [...document.querySelectorAll('.menu-item')].map((element) => ({
    name: element.querySelector('[data-menu=name]').value,
    url: element.querySelector('[data-menu=url]').value,
    // 0 是有效权重：只在输入完全为空时按 0 处理，绝不用 `||` 把 0 变成默认值。
    weight: element.querySelector('[data-menu=weight]').value.trim() === ''
      ? 0
      : Number(element.querySelector('[data-menu=weight]').value),
  }));
}

// 读取控件当前值。返回 { values, missing }，missing 是“清空了的数字输入”，
// 这类输入无法映射成合法数字，必须阻止保存而不是静默写入 0 或 NaN。
function readFieldInputs(schema) {
  const values = {};
  const missing = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const element = document.querySelector(`[data-config="${field.path}"]`);
      if (!element || element.disabled) continue;
      if (field.type === 'boolean') values[field.path] = element.checked;
      else if (field.type === 'number') {
        if (element.value.trim() === '') missing.push(field.path);
        else values[field.path] = Number(element.value);
      } else if (field.type === 'select') {
        const next = selectOptionValue(field, element.value);
        if (next !== undefined) values[field.path] = next;
      } else values[field.path] = element.value;
    }
  }
  return { values, missing };
}

// 打开设置时的不可变基线。之后所有比较都以它为参照，
// 并且在保存成功前不会被任何响应改写（避免“读到新版本但用旧值”导致的静默覆盖）。
function createBaseline(data) {
  return Object.freeze({
    values: JSON.parse(JSON.stringify(data.values || {})),
    menus: JSON.parse(JSON.stringify(data.menus || [])),
    raw: data.raw || '',
    versions: Object.freeze({ ...(data.versions || {}) }),
  });
}

function projectMenu(menu) {
  return { name: menu.name, url: menu.url, weight: menu.weight };
}

function menusEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((menu, index) => sameValue(projectMenu(menu), projectMenu(right[index])));
}

// 只比较本次真正提交的键，并按真实类型比较（不 String() 化）。
function changedValues(reference, values) {
  const changed = {};
  for (const [fieldPath, next] of Object.entries(values)) {
    const previous = Object.hasOwn(reference, fieldPath) ? reference[fieldPath] : undefined;
    if (!sameValue(previous, next)) changed[fieldPath] = next;
  }
  return changed;
}

function summarize(fields, schema, changed) {
  const labels = new Map();
  for (const section of schema.sections) for (const field of section.fields) labels.set(field.path, field.label || field.path);
  return Object.keys(changed).map((fieldPath) => {
    const meta = fields?.[fieldPath];
    return `${labels.get(fieldPath) || fieldPath}${meta && meta.editable === false ? '（需高级配置）' : ''}`;
  });
}

const CONFLICT_TEXT = {
  SETTINGS_VERSION_REQUIRED: '当前页面缺少配置版本（旧版后端或缓存的旧界面）。本次没有提交任何改动；你的编辑仍保留，请重新载入本页后再保存。',
  SCHEMA_CHANGED: '主题配置契约已更新，请重新载入设置页后再保存。你的编辑仍保留在页面中。',
  IDENTITY_CHANGED: '站点数据（作者/头像）已在别处修改，本次没有写入任何文件。请重新载入后重试。',
  SETTINGS_CHANGED: 'hugo.toml 已在别处修改（外部编辑器或另一个窗口），本次没有写入任何文件。请重新载入后比较差异。',
  INVALID_TOML: 'hugo.toml 存在 TOML 语法错误，本次没有写入任何文件。请用“高级配置”修正。',
  FIELD_NOT_EDITABLE: '该字段在当前文件中的写法无法安全改写，请用“高级配置”修改原文。',
};

function errorText(error) {
  if (error instanceof ApiError) {
    if (error.code && CONFLICT_TEXT[error.code]) return CONFLICT_TEXT[error.code];
    if (error.isUnconfirmed) return error.message;
  }
  return error?.message || '保存失败。';
}

export async function renderSettings({ page, bindCommon, refresh }) {
  const revision = ++settingsRevision;
  const data = await api('/api/settings');
  if (revision !== settingsRevision || state.view !== 'settings') return;
  state.settings = data;

  let baseline = createBaseline(data);
  let saving = false;

  const schema = safeSchema(data.schema);
  const modes = data.fieldModes || {};
  const menusLocked = data.menusMode?.editable === false;
  const sections = schema.sections.map((section, index) =>
    `<details ${index < 2 || section.id === 'mobileLayout' ? 'open' : ''}><summary>${esc(section.label || section.id || '设置')}</summary><div class="settings-grid">${section.fields.map((field) => settingField(field, data.values || {}, modes[field.path])).join('')}</div></details>`
  ).join('');
  const syntaxWarning = data.valid === false && data.syntaxError
    ? `<div class="runtime-alert" role="alert"><span>!</span><div><b>hugo.toml 当前存在 TOML 语法错误（第 ${Number(data.syntaxError.line) || 0} 行第 ${Number(data.syntaxError.column) || 0} 列）</b><small>${esc(data.syntaxError.message)}。可视化保存会被拒绝，请先用“高级配置”修正原文。</small></div></div>`
    : '';

  $('#main').innerHTML =
    page('博客设置', '模块化管理站点身份、视觉、阅读与交互；保存后由 Hugo 自动重建。') +
    syntaxWarning +
    `<div class="settings">${sections}
      <details><summary>导航</summary><div id="menus"></div>${menusLocked ? `<p class="muted">当前 menus.main 使用了无法安全定位的写法（${esc(data.menusMode.reason || '未知')}），菜单编辑已停用，请用“高级配置”修改。</p>` : ''}
      <p><button class="btn" id="add-menu" type="button" ${menusLocked ? 'disabled' : ''}>添加菜单</button></p></details>
      <p><button class="btn primary" id="save-settings" type="button">保存设置</button></p>
      <details><summary>高级配置：hugo.toml 原文</summary><label class="field"><textarea id="raw-settings">${esc(data.raw)}</textarea></label><p><button class="btn" id="save-raw-settings" type="button">保存原文</button></p></details>
    </div>`;

  const menusScope = $('#menus');
  menusScope.innerHTML = (data.menus || []).map(menuMarkup).join('');
  bindMenuDeletes();
  $('#add-menu').onclick = () => {
    menusScope.insertAdjacentHTML('beforeend', menuMarkup());
    bindMenuDeletes();
  };

  // 渲染完成后的控件初始值就是 diff 参照：缺失键显示的是 schema 默认值，
  // 用户没有真的改动它时不应被当成“新设置值”写进文件。
  const initial = readFieldInputs(schema).values;

  $('#save-settings').onclick = async () => {
    const button = $('#save-settings');
    if (saving) return;
    const { values, missing } = readFieldInputs(schema);
    if (missing.length) {
      toast(`有 ${missing.length} 个数字字段为空；请填写数值后再保存。`);
      return;
    }
    const changed = changedValues(initial, values);
    const nextMenus = readMenuInputs();
    const menusChanged = !menusEqual(baseline.menus, nextMenus);

    if (!Object.keys(changed).length && !menusChanged) {
      // 没有任何变化：不发请求、不写文件、不重建。
      toast('没有检测到修改，未发送保存请求，也未触发重建。');
      return;
    }

    const body = {
      baseVersion: baseline.versions.settings,
      schemaVersion: baseline.versions.schema,
      values: changed,
    };
    if (Object.hasOwn(changed, 'params.author') || Object.hasOwn(changed, 'params.avatar')) {
      body.identityVersion = baseline.versions.identity;
    }
    if (menusChanged) body.menus = nextMenus;

    saving = true;
    button.disabled = true;
    button.textContent = '正在保存…';
    const labels = summarize(modes, schema, changed);
    try {
      const result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
      if (revision !== settingsRevision || state.view !== 'settings') return;
      if (result.changed === false) {
        toast('服务器判定没有需要写入的改动，站点未重建。');
        return;
      }
      // 只把本次已提交的值并入新基线。不 refresh 整页：
      // 保存期间继续输入的内容必须保持未保存状态，页面也不能被回卷。
      baseline = Object.freeze({
        values: Object.freeze({ ...baseline.values, ...changed }),
        menus: Object.freeze(JSON.parse(JSON.stringify(result.menus || (menusChanged ? nextMenus : baseline.menus)))),
        raw: typeof result.raw === 'string' ? result.raw : baseline.raw,
        versions: Object.freeze({ ...baseline.versions, ...(result.versions || {}) }),
      });
      for (const [fieldPath, value] of Object.entries(changed)) initial[fieldPath] = value;
      const tail = labels.length ? `（${labels.slice(0, 4).join('、')}${labels.length > 4 ? ' 等' : ''}）` : '';
      toast(`已保存${tail}；Hugo 正在重建。`);
      // 保存后如果仍有未提交的输入，明确提示，避免用户以为都存上了。
      const stillDirty = Object.keys(changedValues(initial, readFieldInputs(schema).values)).length > 0;
      if (stillDirty) button.textContent = '保存设置 · 有未提交修改';
    } catch (error) {
      // 冲突：保留本地编辑，不自动重试、不采用服务器版本静默覆盖。
      toast(errorText(error));
      button.textContent = '保存设置 · 有未提交修改';
    } finally {
      saving = false;
      button.disabled = false;
    }
  };

  $('#save-raw-settings').onclick = async () => {
    const button = $('#save-raw-settings');
    if (saving) return;
    const raw = $('#raw-settings').value;
    if (raw === baseline.raw) {
      toast('原文没有变化，未写入任何文件。');
      return;
    }
    saving = true;
    button.disabled = true;
    try {
      const result = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          raw,
          baseVersion: baseline.versions.settings,
          schemaVersion: baseline.versions.schema,
          identityVersion: baseline.versions.identity,
        }),
      });
      if (result.changed === false) {
        toast('原文没有变化，未写入任何文件。');
        return;
      }
      baseline = Object.freeze({
        ...baseline,
        raw,
        versions: Object.freeze({ ...baseline.versions, ...(result.versions || {}) }),
      });
      toast(result.identitySync?.length
        ? `hugo.toml 已保存，并同步更新了站点数据的 ${result.identitySync.map((item) => item.yamlKey).join('、')}。`
        : 'hugo.toml 已保存。');
    } catch (error) {
      toast(errorText(error));
    } finally {
      saving = false;
      button.disabled = false;
    }
  };
  bindCommon();
}
