import { isDeepStrictEqual } from 'node:util';
import { isObject } from './value.mjs';

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function fieldsFrom(schema) {
  if (!isObject(schema) || !Array.isArray(schema.sections)) throw new Error('主题配置契约无效。');
  const fields = new Map();
  for (const section of schema.sections) {
    if (!isObject(section) || !Array.isArray(section.fields)) throw new Error('主题配置 section 无效。');
    for (const field of section.fields) {
      if (!isObject(field) || typeof field.path !== 'string' || !field.path) throw new Error('主题配置字段无效。');
      if (fields.has(field.path)) throw new Error(`主题配置字段重复：${field.path}`);
      fields.set(field.path, field);
    }
  }
  return fields;
}

function validUrl(value) {
  return value === '' || /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value);
}

function validateField(field, value) {
  const type = field.type || 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      && (!Number.isFinite(field.min) || value >= field.min)
      && (!Number.isFinite(field.max) || value <= field.max);
  }
  if (type === 'select') return (field.options || []).some((option) => isDeepStrictEqual(option?.value, value));
  if (type === 'color') return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);
  if (type === 'url') return typeof value === 'string' && validUrl(value);
  return typeof value === 'string';
}

export function validateThemeSettingsPatch(schema, values) {
  if (!isObject(values)) throw badRequest('设置参数必须是对象。');
  const fields = fieldsFrom(schema);
  for (const [path, value] of Object.entries(values)) {
    const field = fields.get(path);
    if (!field) throw badRequest(`未知设置字段：${path}`);
    if (!validateField(field, value)) throw badRequest(`设置字段 ${path} 的值无效。`);
  }
  return values;
}

export function validateMenus(menus) {
  if (!Array.isArray(menus) || menus.length > 50) throw badRequest('导航菜单格式无效。');
  for (const [index, menu] of menus.entries()) {
    if (!isObject(menu)) throw badRequest(`第 ${index + 1} 个导航项无效。`);
    if (typeof menu.name !== 'string' || !menu.name.trim() || menu.name.length > 80 || /[\r\n\0]/.test(menu.name)) throw badRequest(`第 ${index + 1} 个导航名称无效。`);
    if (typeof menu.url !== 'string' || !menu.url.trim() || menu.url.length > 1000 || /[\r\n\0]/.test(menu.url)) throw badRequest(`第 ${index + 1} 个导航地址无效。`);
    if (typeof menu.weight !== 'number' || !Number.isFinite(menu.weight)) throw badRequest(`第 ${index + 1} 个导航权重无效。`);
  }
  return menus;
}
