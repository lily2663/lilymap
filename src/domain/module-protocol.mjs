import { isDeepStrictEqual } from 'node:util';
import { isObject } from './value.mjs';

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SLOT = /^[a-z][a-z0-9-]*\.[A-Za-z_][A-Za-z0-9_-]*$/;
const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'select', 'color', 'url']);

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('..');
}

export function validateModuleValue(value, definition, label) {
  const type = definition?.type || 'string';
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值。`);
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是数字。`);
    if (Number.isFinite(definition?.min) && value < definition.min) throw new Error(`${label} 不能小于 ${definition.min}。`);
    if (Number.isFinite(definition?.max) && value > definition.max) throw new Error(`${label} 不能大于 ${definition.max}。`);
  }
  if ((type === 'string' || type === 'color' || type === 'url') && typeof value !== 'string') throw new Error(`${label} 必须是文本。`);
  if (type === 'select') {
    const options = Array.isArray(definition.options) ? definition.options : [];
    if (options.length && !options.some((option) => isDeepStrictEqual(option?.value, value))) throw new Error(`${label} 不在允许选项中。`);
  }
  if (type === 'url' && value && !/^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value)) throw new Error(`${label} 必须是 http(s) 地址或站内相对路径。`);
}

export function validateModuleManifestShape(fileId, manifest) {
  if (!isObject(manifest)) throw new Error(`模块 ${fileId} 必须是对象。`);
  if (typeof manifest.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.id)) throw new Error(`模块 ${fileId} 的 id 不合法。`);
  if (manifest.id !== fileId) throw new Error(`模块文件 ${fileId}.yaml 与 manifest id ${manifest.id} 不一致。`);
  if (manifest.apiVersion != null && manifest.apiVersion !== 'lily-module/v1') throw new Error(`模块 ${manifest.id} 使用不支持的 apiVersion: ${manifest.apiVersion}`);
  if (manifest.version != null && (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version))) throw new Error(`模块 ${manifest.id} 的 version 必须是 SemVer。`);

  for (const key of ['name', 'category', 'type', 'icon', 'description', 'context']) {
    if (manifest[key] != null && typeof manifest[key] !== 'string') throw new Error(`模块 ${manifest.id} 的 ${key} 必须是文本。`);
  }

  if (!Array.isArray(manifest.allowedSlots) || manifest.allowedSlots.length < 1 || !manifest.allowedSlots.every((slot) => typeof slot === 'string' && SLOT.test(slot))) {
    throw new Error(`模块 ${manifest.id} 缺少合法的 allowedSlots。`);
  }
  if (new Set(manifest.allowedSlots).size !== manifest.allowedSlots.length) throw new Error(`模块 ${manifest.id} 的 allowedSlots 不能重复。`);

  if (manifest.template != null && !isObject(manifest.template)) throw new Error(`模块 ${manifest.id} 的 template 必须是对象。`);
  if (manifest.template?.partial != null && !safeRelative(manifest.template.partial)) throw new Error(`模块 ${manifest.id} 的模板路径不安全。`);

  if (manifest.assets != null && !isObject(manifest.assets)) throw new Error(`模块 ${manifest.id} 的 assets 必须是对象。`);
  for (const key of ['styles', 'scripts']) {
    const resources = manifest.assets?.[key];
    if (resources == null) continue;
    if (!Array.isArray(resources) || !resources.every(safeRelative) || new Set(resources).size !== resources.length) throw new Error(`模块 ${manifest.id} 的 assets.${key} 无效。`);
  }

  for (const key of ['capabilities', 'defaults', 'schema']) {
    if (manifest[key] != null && !isObject(manifest[key])) throw new Error(`模块 ${manifest.id} 的 ${key} 必须是对象。`);
  }

  for (const [key, definition] of Object.entries(manifest.schema || {})) {
    if (!isObject(definition) || !FIELD_TYPES.has(definition.type)) throw new Error(`模块 ${manifest.id} 的 schema.${key}.type 无效。`);
    for (const textKey of ['label', 'help']) if (definition[textKey] != null && typeof definition[textKey] !== 'string') throw new Error(`模块 ${manifest.id} 的 schema.${key}.${textKey} 必须是文本。`);
    for (const numberKey of ['min', 'max']) if (definition[numberKey] != null && (typeof definition[numberKey] !== 'number' || !Number.isFinite(definition[numberKey]))) throw new Error(`模块 ${manifest.id} 的 schema.${key}.${numberKey} 必须是数字。`);
    if (definition.step != null && (typeof definition.step !== 'number' || !Number.isFinite(definition.step) || definition.step <= 0)) throw new Error(`模块 ${manifest.id} 的 schema.${key}.step 必须大于 0。`);
    if (definition.options != null) {
      if (!Array.isArray(definition.options) || !definition.options.every((option) => isObject(option) && Object.hasOwn(option, 'value') && (option.label == null || typeof option.label === 'string'))) {
        throw new Error(`模块 ${manifest.id} 的 schema.${key}.options 无效。`);
      }
    }
  }

  for (const [key, value] of Object.entries(manifest.defaults || {})) {
    if (manifest.schema?.[key]) validateModuleValue(value, manifest.schema[key], `模块 ${manifest.id} 默认值 ${key}`);
  }
}
