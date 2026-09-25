import YAML from 'yaml';
import { isObject, parseYaml } from './value.mjs';
import { validateModuleManifestShape, validateModuleValue } from './module-protocol.mjs';

export function normalizeLayout(value, label) {
  if (!isObject(value.slots)) throw new Error(`${label} 缺少 slots 对象。`);
  const slots = {};
  for (const [slot, instances] of Object.entries(value.slots)) {
    const normalizedInstances = instances == null ? [] : instances;
    if (!/^[A-Za-z_][\w-]*$/.test(slot) || !Array.isArray(normalizedInstances)) throw new Error(`${label} 的 slot ${slot} 无效。`);
    slots[slot] = normalizedInstances.map((instance, index) => {
      if (!isObject(instance) || !String(instance.id || '').trim() || !String(instance.module || '').trim()) throw new Error(`${label} 的 ${slot}[${index}] 缺少 id 或 module。`);
      if (Object.hasOwn(instance, 'enabled') && typeof instance.enabled !== 'boolean') throw new Error(`${label} 的 ${slot}[${index}].enabled 必须是布尔值。`);
      if (Object.hasOwn(instance, 'order') && (typeof instance.order !== 'number' || !Number.isFinite(instance.order))) throw new Error(`${label} 的 ${slot}[${index}].order 必须是数字。`);
      return { ...instance, id: String(instance.id), module: String(instance.module), config: isObject(instance.config) ? instance.config : {} };
    });
  }
  const declared = Array.isArray(value.slotOrder) ? value.slotOrder.map(String) : Object.keys(slots);
  const slotOrder = [...new Set([...declared.filter((slot) => Object.hasOwn(slots, slot)), ...Object.keys(slots)])];
  return { ...value, kind: String(value.kind || 'page'), slots, slotOrder };
}

export function parseLayout(raw, label = '布局') {
  return normalizeLayout(parseYaml(raw, label), label);
}

export function serializeLayout(layout) {
  return YAML.stringify(normalizeLayout(layout, '布局'));
}

export function normalizeModuleManifest(fileId, raw, source) {
  const manifest = parseYaml(raw, `模块 ${fileId}`);
  validateModuleManifestShape(fileId, manifest);
  const id = manifest.id;
  const apiVersion = manifest.apiVersion || 'lily-module/v1';
  const partial = manifest.template?.partial || `lily/modules/${id}/render.html`;
  const assets = isObject(manifest.assets) ? manifest.assets : {};
  return {
    ...manifest,
    id,
    apiVersion,
    name: manifest.name || id,
    description: manifest.description || '',
    category: manifest.category || 'general',
    version: manifest.version || '0.1.0',
    context: manifest.context || 'any',
    defaults: isObject(manifest.defaults) ? manifest.defaults : {},
    schema: isObject(manifest.schema) ? manifest.schema : {},
    template: { ...(isObject(manifest.template) ? manifest.template : {}), partial },
    assets,
    capabilities: isObject(manifest.capabilities) ? manifest.capabilities : {},
    source,
  };
}

export function validateLayoutAgainstRegistry(layout, modules) {
  const ids = new Set();
  for (const [slot, instances] of Object.entries(layout.slots)) {
    const fullSlot = `${layout.kind}.${slot}`;
    for (const instance of instances) {
      if (ids.has(instance.id)) throw new Error(`布局实例 id 重复：${instance.id}`);
      ids.add(instance.id);
      const manifest = modules[instance.module];
      if (!manifest) throw new Error(`未知模块：${instance.module}`);
      if (!manifest.allowedSlots.includes(fullSlot)) throw new Error(`模块 ${instance.module} 不能放入 ${fullSlot}。`);
      for (const [key, value] of Object.entries(instance.config || {})) {
        if (manifest.schema?.[key]) validateModuleValue(value, manifest.schema[key], `模块 ${instance.module} 的 ${key}`);
      }
    }
  }
}
