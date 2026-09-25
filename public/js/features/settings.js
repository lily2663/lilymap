import { api } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';

function settingField(field, currentValue) {
  const value = currentValue ?? field.default ?? '';
  const help = field.help || field.path;
  if (field.type === 'boolean') {
    return `<label class="switch"><span><b>${esc(field.label)}</b><p>${esc(help)}</p></span><input data-config="${field.path}" type="checkbox" ${value ? 'checked' : ''}></label>`;
  }
  if (field.type === 'select') {
    return `<label class="field"><span>${esc(field.label)}</span><select data-config="${field.path}">${(field.options || []).map((option) => `<option value="${esc(option.value)}" ${option.value === value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select><small class="muted">${esc(help)}</small></label>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'color' ? 'color' : field.type === 'url' ? 'url' : 'text';
  const limits = field.type === 'number'
    ? ['min', 'max', 'step'].filter((key) => Object.hasOwn(field, key)).map((key) => `${key}="${esc(field[key])}"`).join(' ')
    : '';
  return `<label class="field"><span>${esc(field.label)}</span><input data-config="${field.path}" type="${type}" value="${esc(value)}" ${limits}><small class="muted">${esc(help)}</small></label>`;
}

function menuMarkup(menu = { name: '新菜单', url: '/', weight: 60 }) {
  return `<div class="menu-item"><input data-menu="name" value="${esc(menu.name)}"><input data-menu="url" value="${esc(menu.url)}"><input data-menu="weight" type="number" value="${esc(menu.weight)}"><button class="btn">删除</button></div>`;
}

function bindMenuDeletes() {
  document.querySelectorAll('.menu-item button').forEach((button) => {
    button.onclick = () => button.parentElement.remove();
  });
}

export async function renderSettings({ page, bindCommon, refresh }) {
  const data = await api('/api/settings');
  state.settings = data;
  const fields = data.schema.sections.map((section, index) =>
    `<details ${index < 2 || section.id === 'mobileLayout' ? 'open' : ''}><summary>${esc(section.label)}</summary><div class="settings-grid">${section.fields.map((field) => settingField(field, data.values[field.path])).join('')}</div></details>`
  ).join('');

  $('#main').innerHTML =
    page('博客设置', '模块化管理站点身份、视觉、阅读与交互；保存后由 Hugo 自动重建。') +
    `<div class="settings">${fields}<details><summary>导航</summary><div id="menus"></div><button class="btn" id="add-menu">添加菜单</button></details><p><button class="btn primary" id="save-settings">保存设置</button></p><details><summary>高级配置：hugo.toml 原文</summary><label class="field"><textarea id="raw-settings">${esc(data.raw)}</textarea></label><p><button class="btn" id="save-raw-settings">保存原文</button></p></details></div>`;

  const menus = $('#menus');
  menus.innerHTML = data.menus.map(menuMarkup).join('');
  bindMenuDeletes();
  $('#add-menu').onclick = () => {
    menus.insertAdjacentHTML('beforeend', menuMarkup());
    bindMenuDeletes();
  };

  $('#save-settings').onclick = async () => {
    try {
      const values = {};
      data.schema.sections.flatMap((section) => section.fields).forEach((field) => {
        const element = document.querySelector(`[data-config="${field.path}"]`);
        values[field.path] = field.type === 'boolean'
          ? element.checked
          : field.type === 'number'
            ? Number(element.value)
            : element.value;
      });
      const nextMenus = [...document.querySelectorAll('.menu-item')].map((element) => ({
        name: element.querySelector('[data-menu=name]').value,
        url: element.querySelector('[data-menu=url]').value,
        weight: Number(element.querySelector('[data-menu=weight]').value),
      }));
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ values, menus: nextMenus }),
      });
      toast('模块设置已保存；Hugo 正在重建。');
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };

  $('#save-raw-settings').onclick = async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ raw: $('#raw-settings').value }),
      });
      toast('hugo.toml 已保存。');
    } catch (error) {
      toast(error.message);
    }
  };
  bindCommon();
}
