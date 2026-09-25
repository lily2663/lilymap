import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { resolveInside } from '../fs/path-security.mjs';
import { normalizeLayout, normalizeModuleManifest, parseLayout, serializeLayout, validateLayoutAgainstRegistry } from '../domain/layout.mjs';
import { updateModulePlacement } from '../domain/module-config.mjs';
import { parseToml } from '../domain/toml.mjs';
import { parseYaml } from '../domain/value.mjs';

function validLayoutName(value) {
  return typeof value === 'string' && /^[\w-]+$/.test(value);
}

export function createLayoutModuleService({
  repoRoot,
  builtInLayoutsRoot,
  userLayoutsRoot,
  builtInModulesRoot,
  userModulesRoot,
  trashRoot,
  maxBodyBytes,
  fileTransaction,
  atomicWrite,
  scheduleBuild,
  fsApi = fs,
  now = () => new Date(),
}) {
  const exists = async (target) => {
    try { await fsApi.access(target); return true; } catch { return false; }
  };
  const relativeToRepo = (target) => path.relative(repoRoot, target).split(path.sep).join('/');
  const inside = (root, candidate) => resolveInside(root, candidate);
  const yamlFiles = async (root) => (await exists(root))
    ? (await fsApi.readdir(root)).filter((name) => name.endsWith('.yaml')).sort().map((name) => path.join(root, name))
    : [];
  const layoutRevisionRoot = (name) => path.join(trashRoot, 'layouts', name);
  const stamp = () => now().toISOString().replace(/[:.]/g, '-');

  async function snapshotLayout(name, target) {
    if (!(await exists(target))) return null;
    const destination = path.join(layoutRevisionRoot(name), `${stamp()}.yaml`);
    await fsApi.mkdir(path.dirname(destination), { recursive: true });
    await fsApi.copyFile(target, destination);
    return relativeToRepo(destination);
  }

  async function layoutHistory(name) {
    if (!validLayoutName(name)) throw new Error('布局名称不合法。');
    const root = layoutRevisionRoot(name);
    if (!(await exists(root))) return [];
    const files = (await fsApi.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.yaml$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return Promise.all(files.map(async (file) => {
      const target = path.join(root, file);
      const stat = await fsApi.stat(target);
      return { revision: file, savedAt: stat.mtime.toISOString(), path: relativeToRepo(target) };
    }));
  }

  async function loadModuleRegistry() {
    const modules = {};
    for (const [root, source] of [[builtInModulesRoot, 'built-in'], [userModulesRoot, 'site']]) {
      for (const file of await yamlFiles(root)) {
        const id = path.basename(file, '.yaml');
        modules[id] = normalizeModuleManifest(id, await fsApi.readFile(file, 'utf8'), source);
      }
    }
    if (modules.welcome) {
      const values = parseToml(await fsApi.readFile(path.join(repoRoot, 'hugo.toml'), 'utf8')).values;
      modules.welcome.siteDefaults = {};
      for (const key of Object.keys(modules.welcome.schema)) {
        const setting = Object.keys(values).find((name) => name.toLowerCase() === `params.welcome.${key}`.toLowerCase());
        if (setting) modules.welcome.siteDefaults[key] = values[setting];
      }
    }
    return modules;
  }

  async function loadLayoutEditor() {
    const layouts = new Map();
    for (const [root, source] of [[builtInLayoutsRoot, 'built-in'], [userLayoutsRoot, 'site']]) {
      for (const file of await yamlFiles(root)) {
        const name = path.basename(file, '.yaml');
        const raw = await fsApi.readFile(file, 'utf8');
        layouts.set(name, { name, parsed: parseLayout(raw, `布局 ${name}`), raw, source });
      }
    }
    return {
      layouts: [...layouts.values()].sort((a, b) => a.name.localeCompare(b.name)),
      modules: await loadModuleRegistry(),
    };
  }

  async function moduleUsage() {
    const { layouts, modules } = await loadLayoutEditor();
    const usage = {};
    for (const layout of layouts) {
      for (const [slot, instances] of Object.entries(layout.parsed.slots)) {
        for (const instance of instances) {
          (usage[instance.module] ||= []).push({ layout: layout.name, slot, instance: instance.id });
        }
      }
    }
    return { modules, layouts, usage };
  }

  function siteModulePaths(id, manifest) {
    const relative = [
      `data/lily/modules/${id}.yaml`,
      manifest.template?.partial
        ? `layouts/partials/${manifest.template.partial}`
        : `layouts/partials/lily/modules/${id}/render.html`,
      ...(manifest.assets?.styles || []).map((file) => `assets/${file}`),
      ...(manifest.assets?.scripts || []).map((file) => `assets/${file}`),
    ];
    return [...new Set(relative.map((file) => inside(repoRoot, file)).filter(Boolean))];
  }

  async function installSiteModule(request) {
    if (typeof request.manifest !== 'string' || request.manifest.length > maxBodyBytes) throw new Error('模块 manifest 无效。');
    const rawManifest = request.manifest.replace(/^\uFEFF/, '');
    const preview = parseYaml(rawManifest, '模块 manifest');
    const id = String(preview.id || '').trim();
    const manifest = normalizeModuleManifest(id, rawManifest, 'site');
    if (manifest.template.partial !== `lily/modules/${id}/render.html`) {
      throw new Error('本地模块模板必须位于 lily/modules/<id>/render.html。');
    }
    if (typeof request.template !== 'string' || !request.template.trim() || request.template.length > maxBodyBytes) {
      throw new Error('模块必须提供 render.html 模板。');
    }

    const registry = await loadModuleRegistry();
    if (registry[id] && registry[id].source === 'built-in') throw new Error('不能覆盖内置模块；请使用新的模块 id。');
    if (registry[id] && request.replace !== true) throw new Error('该本地模块已存在；确认更新后再覆盖。');

    const stylePath = `lily/modules/${id}.css`;
    const scriptPath = `lily/modules/${id}.js`;
    for (const file of manifest.assets.styles || []) if (file !== stylePath) throw new Error(`CSS 必须命名为 ${stylePath}。`);
    for (const file of manifest.assets.scripts || []) if (file !== scriptPath) throw new Error(`JS 必须命名为 ${scriptPath}。`);
    if ((manifest.assets.styles || []).includes(stylePath) && typeof request.style !== 'string') throw new Error('manifest 声明了 CSS，但未提供样式内容。');
    if ((manifest.assets.scripts || []).includes(scriptPath) && typeof request.script !== 'string') throw new Error('manifest 声明了 JS，但未提供脚本内容。');

    const files = [
      { target: path.join(userModulesRoot, `${id}.yaml`), content: rawManifest },
      { target: path.join(repoRoot, 'layouts', 'partials', manifest.template.partial), content: request.template },
    ];
    if ((manifest.assets.styles || []).includes(stylePath)) {
      files.push({ target: path.join(repoRoot, 'assets', stylePath), content: request.style });
    }
    if ((manifest.assets.scripts || []).includes(scriptPath)) {
      files.push({ target: path.join(repoRoot, 'assets', scriptPath), content: request.script });
    }
    await fileTransaction.replaceFiles(files);
    return { id, manifest };
  }

  async function moveModuleToTrash(id, manifest) {
    const existing = [];
    for (const source of siteModulePaths(id, manifest)) {
      if (await exists(source)) existing.push(source);
    }
    const destinationRoot = path.join(trashRoot, 'modules', `${stamp()}-${id}`);
    const moved = [];
    try {
      for (const source of existing) {
        const destination = inside(destinationRoot, relativeToRepo(source));
        if (!destination) throw new Error('模块回收路径无效。');
        await fsApi.mkdir(path.dirname(destination), { recursive: true });
        await fsApi.rename(source, destination);
        moved.push({ source, destination });
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        await fsApi.mkdir(path.dirname(item.source), { recursive: true }).catch(() => {});
        await fsApi.rename(item.destination, item.source).catch(() => {});
      }
      throw error;
    }
    return destinationRoot;
  }

  async function uninstallSiteModule(id) {
    const registry = await loadModuleRegistry();
    const manifest = registry[id];
    if (!manifest) throw new Error('模块不存在。');
    if (manifest.source !== 'site') throw new Error('内置模块不能卸载；可以从布局中移除。');
    const { usage } = await moduleUsage();
    if (usage[id]?.length) {
      throw new Error(`模块仍被 ${usage[id].map((item) => `${item.layout}.${item.slot}`).join('、')} 使用，请先从布局移除。`);
    }
    const destinationRoot = await moveModuleToTrash(id, manifest);
    scheduleBuild();
    return { id, trashedTo: relativeToRepo(destinationRoot) };
  }

  async function configureModule(request) {
    if (!validLayoutName(request.layout || '')) throw new Error('布局名称不合法。');
    const { layouts, modules } = await loadLayoutEditor();
    const current = layouts.find((entry) => entry.name === request.layout);
    if (!current) throw new Error('布局不存在。');
    const { layout, placement } = updateModulePlacement(current.parsed, modules, request);
    const target = inside(userLayoutsRoot, `${request.layout}.yaml`);
    if (!target) throw new Error('布局路径不安全。');
    const backup = await snapshotLayout(request.layout, target);
    await atomicWrite(target, serializeLayout(layout));
    return { placement, backup };
  }

  async function saveLayout(request) {
    const name = String(request.name || '');
    if (!validLayoutName(name)) throw new Error('布局名称不合法。');
    const candidate = typeof request.raw === 'string'
      ? request.raw
      : request.parsed ? YAML.stringify(request.parsed) : '';
    if (!candidate || candidate.length > maxBodyBytes) throw new Error('布局内容无效。');
    const layout = parseLayout(candidate, `布局 ${name}`);
    validateLayoutAgainstRegistry(layout, await loadModuleRegistry());
    const target = inside(userLayoutsRoot, `${name}.yaml`);
    if (!target) throw new Error('布局路径不安全。');
    const backup = await snapshotLayout(name, target);
    await atomicWrite(target, serializeLayout(layout));
    return { path: relativeToRepo(target), source: 'site', backup };
  }

  async function restoreLayout(request) {
    const name = String(request.name || '');
    const revision = String(request.revision || '');
    if (!validLayoutName(name) || !/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.yaml$/.test(revision)) {
      throw new Error('布局历史版本无效。');
    }
    const source = inside(layoutRevisionRoot(name), revision);
    const target = inside(userLayoutsRoot, `${name}.yaml`);
    if (!source || !target || !(await exists(source))) throw new Error('布局历史版本不存在。');
    const layout = parseLayout(await fsApi.readFile(source, 'utf8'), `布局历史 ${name}`);
    validateLayoutAgainstRegistry(layout, await loadModuleRegistry());
    const backup = await snapshotLayout(name, target);
    await atomicWrite(target, serializeLayout(layout));
    return { path: relativeToRepo(target), backup };
  }

  async function resetLayout(request) {
    const name = String(request.name || '');
    if (!validLayoutName(name)) throw new Error('布局名称不合法。');
    const target = inside(userLayoutsRoot, `${name}.yaml`);
    const builtIn = inside(builtInLayoutsRoot, `${name}.yaml`);
    if (!target || !builtIn || !(await exists(target)) || !(await exists(builtIn))) {
      throw new Error('该布局没有可恢复的主题默认版本。');
    }
    const destination = path.join(layoutRevisionRoot(name), `override-${stamp()}.yaml`);
    await fsApi.mkdir(path.dirname(destination), { recursive: true });
    await fsApi.rename(target, destination);
    scheduleBuild();
    return { restoredSource: 'built-in', trashedTo: relativeToRepo(destination) };
  }

  return {
    snapshotLayout,
    layoutHistory,
    loadModuleRegistry,
    loadLayoutEditor,
    moduleUsage,
    installSiteModule,
    uninstallSiteModule,
    configureModule,
    saveLayout,
    restoreLayout,
    resetLayout,
  };
}
