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

// RFC3339 = 完整日期 + 时间 + 强制时区偏移（Z 或 ±HH:MM）。
// 用真实解析而不是只查正则：2026-13-45T99:99:99+08:00 能通过粗正则但不是有效时间，
// 而主题的 feeds/effective-time.html 会把它排除并记诊断 —— 与其让用户以为生效，
// 不如在保存前拒绝。
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

export function isValidRfc3339(value) {
  if (typeof value !== 'string') return false;
  const match = RFC3339.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = numbers;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return false;
  // 用 Date 复核“2 月 30 日”这类越界日期：Date 会把它进位到下个月，因此必须回读比对。
  const stamp = new Date(Date.UTC(y, mo - 1, d));
  if (stamp.getUTCFullYear() !== y || stamp.getUTCMonth() !== mo - 1 || stamp.getUTCDate() !== d) return false;
  if (offsetHour != null && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

// 字段级可选约束，全部由 schema 声明，LilyMap 不硬编码任何字段路径：
//   pattern  —— 正则源字符串，必须整串匹配（用 ^...$ 语义，自动加锚点）。
//   format   —— 目前支持 "rfc3339" 与 "url"。
// 未声明时行为与旧版本一致（只按 type 校验），因此旧 schema 不会因缺字段而报错。
function satisfiesDeclaration(field, value) {
  if (typeof field.pattern === 'string' && field.pattern) {
    let expression;
    try {
      expression = new RegExp(`^(?:${field.pattern})$`, 'u');
    } catch {
      // schema 写错了不该让保存变成 500：跳过该约束，由 type 校验兜底。
      return true;
    }
    if (!expression.test(String(value))) return false;
  }
  if (field.format === 'rfc3339') return isValidRfc3339(value);
  if (field.format === 'url') return validUrl(value);
  return true;
}

function validateField(field, value) {
  const type = field.type || 'string';
  if (!satisfiesDeclaration(field, value)) return false;
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
