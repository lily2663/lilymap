import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { validateFriends, validateProfile } from '../domain/profile.mjs';
import { validateMenus, validateThemeSettingsPatch } from '../domain/theme-config.mjs';
import {
  analyzeToml, assertValidToml, menusProjection, parseToml, patchMenus, patchTomlValue, validateToml,
} from '../domain/toml.mjs';
import { parseYaml } from '../domain/value.mjs';

// 只有这两个字段会跨文件同步到 data/site.yaml；identityVersion 也只对它们要求。
const IDENTITY_FIELDS = new Set(['params.author', 'params.avatar']);
const IDENTITY_SYNC = [['params.author', 'author'], ['params.avatar', 'avatar']];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

// bigint 只在 i64 越界时才出现；比较与返回前统一成可序列化标量。
function normalizeComparable(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value) : value.toString();
  }
  return value;
}

function readPath(object, fieldPath) {
  let current = object;
  for (const part of String(fieldPath).split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function guardError(status, message, code, details) {
  return Object.assign(new Error(message), { statusCode: status, code, details });
}

export function createSiteSettingsService({
  repoRoot,
  siteDataFile,
  themeRoot,
  fileTransaction,
  atomicWrite,
  httpError,
  maxBodyBytes,
}) {
  const tomlPath = path.join(repoRoot, 'hugo.toml');
  const schemaPath = path.join(themeRoot, 'theme-config.schema.json');

  // 服务级串行队列：把“读取最新内容 → 版本校验 → 生成候选 → 验证 → replaceFiles
  // → 读取新版本”整段包在同一保护区里。队列只调度现有事务，不新建并行事务系统。
  // 链尾用 then(void, void) 复位，保证上一项失败不会让后续请求永久被拒绝。
  let queueTail = Promise.resolve();
  let queueDepth = 0;
  function exclusive(task) {
    queueDepth += 1;
    const result = queueTail.then(task).finally(() => { queueDepth -= 1; });
    queueTail = result.then(() => {}, () => {});
    return result;
  }

  async function readSchema() {
    const raw = await fs.readFile(schemaPath, 'utf8');
    let schema;
    try {
      schema = JSON.parse(raw);
    } catch {
      throw httpError(500, '主题配置契约不是合法 JSON，请检查主题的 theme-config.schema.json。');
    }
    return { raw, schema, version: sha256(raw) };
  }

  async function readTomlState() {
    const raw = await fs.readFile(tomlPath, 'utf8');
    return { raw, version: sha256(raw) };
  }

  async function readIdentityState() {
    try {
      const raw = await fs.readFile(siteDataFile, 'utf8');
      return { raw, version: sha256(raw), exists: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { raw: '', version: sha256(''), exists: false };
      throw error;
    }
  }

  async function readFriends() {
    const raw = await fs.readFile(siteDataFile, 'utf8');
    const site = parseYaml(raw, '站点数据');
    if (site.friends != null && !Array.isArray(site.friends)) throw new Error('站点数据中的 friends 必须是列表。');
    return { friends: site.friends || [], version: sha256(raw) };
  }

  async function readProfile() {
    const raw = await fs.readFile(siteDataFile, 'utf8');
    const site = parseYaml(raw, '站点数据');
    return {
      profile: {
        author: site.author || '',
        aboutTitle: site.aboutTitle || '',
        about: site.about || [],
        links: site.links || [],
      },
      version: sha256(raw),
    };
  }

  function versionsOf(settings, schema, identity) {
    return { settings, schema, identity };
  }

  async function updateProfile(request) {
    return exclusive(async () => {
      const identity = await readIdentityState();
      if (request.version !== identity.version) {
        throw guardError(409, '个人资料已在别处修改，请刷新后重试。', 'IDENTITY_CHANGED', { currentVersion: identity.version });
      }

      const profile = validateProfile(request.profile);
      const document = YAML.parseDocument(identity.raw, { prettyErrors: true, uniqueKeys: true });
      if (document.errors.length) throw httpError(400, `站点数据 YAML 无效：${document.errors[0].message}`);
      for (const [key, value] of Object.entries(profile)) document.set(key, value);

      const toml = await readTomlState();
      assertValidToml(toml.raw, 'hugo.toml');
      const nextToml = patchTomlValue(toml.raw, 'params.author', profile.author);
      assertValidToml(nextToml, 'hugo.toml');
      await fileTransaction.replaceFiles([
        { target: siteDataFile, content: String(document) },
        { target: tomlPath, content: nextToml },
      ]);
      return { ok: true, ...(await readProfile()) };
    });
  }

  async function updateFriends(request) {
    return exclusive(async () => {
      const identity = await readIdentityState();
      if (request.version !== identity.version) {
        throw guardError(409, '友链配置已在别处修改，请刷新后重试。', 'IDENTITY_CHANGED', { currentVersion: identity.version });
      }

      const friends = validateFriends(request.friends);
      const document = YAML.parseDocument(identity.raw, { prettyErrors: true, uniqueKeys: true });
      if (document.errors.length) throw httpError(400, `站点数据 YAML 无效：${document.errors[0].message}`);
      document.set('friends', friends);
      await atomicWrite(siteDataFile, String(document));
      return { ok: true, ...(await readFriends()) };
    });
  }

  async function readSettings() {
    const [toml, schemaState, identity] = await Promise.all([
      readTomlState(), readSchema(), readIdentityState(),
    ]);
    const parsed = validateToml(toml.raw);
    const analysis = analyzeToml(toml.raw, schemaState.schema);
    const projected = parsed.ok ? parseToml(toml.raw) : { values: {}, menus: [] };
    return {
      raw: toml.raw,
      values: projected.values,
      menus: projected.menus,
      schema: schemaState.schema,
      versions: versionsOf(toml.version, schemaState.version, identity.version),
      capabilities: {
        settingsOptimisticLock: true,
        settingsDiff: true,
        settingsTomlValidation: true,
        settingsRawValidation: true,
        settingsMenusPreserving: analysis.menus.editable,
      },
      fieldModes: analysis.fields,
      menusMode: analysis.menus,
      valid: parsed.ok,
      syntaxError: parsed.ok ? null : { line: parsed.line, column: parsed.column, message: parsed.message },
    };
  }

  // 冲突响应同时给出顶层 currentVersion（受影响文件的当前版本，便于 UI 直接展示）
  // 和完整三份版本，避免调用方只能拿到一个没有语义的哈希。
  function conflictDetails(toml, schemaState, identity, primary) {
    const versions = versionsOf(toml.version, schemaState.version, identity.version);
    return {
      currentVersion: primary === 'identity' ? identity.version : primary === 'schema' ? schemaState.version : toml.version,
      currentSchemaVersion: schemaState.version,
      currentIdentityVersion: identity.version,
      versions,
    };
  }

  function checkCommonGuards(request, toml, schemaState, identity) {
    const baseVersion = typeof request.baseVersion === 'string' ? request.baseVersion : '';
    const schemaVersion = typeof request.schemaVersion === 'string' ? request.schemaVersion : '';
    if (!baseVersion || !schemaVersion) {
      throw guardError(
        428,
        '当前页面缺少配置版本，可能来自旧版 LilyMap 或浏览器缓存的旧界面。请先重新载入本页再保存；你的编辑仍保留在输入框中。',
        'SETTINGS_VERSION_REQUIRED',
        conflictDetails(toml, schemaState, identity, 'settings'),
      );
    }
    if (schemaVersion !== schemaState.version) {
      throw guardError(
        409,
        '主题配置契约已更新（可能切换了主题或更新了主题版本），请重新载入设置页后再保存。',
        'SCHEMA_CHANGED',
        conflictDetails(toml, schemaState, identity, 'schema'),
      );
    }
    if (baseVersion !== toml.version) {
      throw guardError(
        409,
        'hugo.toml 已在别处修改（可能是外部编辑器、另一个 LilyMap 窗口或另一方保存），本次没有写入任何文件。请对比后重新载入。',
        'SETTINGS_CHANGED',
        conflictDetails(toml, schemaState, identity, 'settings'),
      );
    }
    return { baseVersion, schemaVersion };
  }

  // identityVersion 只在本次确实会改作者/头像时要求；纯主题颜色修改不受友链变化影响。
  function checkIdentityGuard(request, toml, schemaState, identity) {
    const identityVersion = typeof request.identityVersion === 'string' ? request.identityVersion : '';
    if (!identityVersion) {
      throw guardError(
        428,
        '本次保存会同步作者或头像到站点数据，但页面缺少站点数据版本。请重新载入本页后再保存。',
        'SETTINGS_VERSION_REQUIRED',
        conflictDetails(toml, schemaState, identity, 'identity'),
      );
    }
    if (identityVersion !== identity.version) {
      throw guardError(
        409,
        '站点数据（data/site.yaml）已在别处修改，本次没有写入任何文件。请重新载入后重试。',
        'IDENTITY_CHANGED',
        conflictDetails(toml, schemaState, identity, 'identity'),
      );
    }
  }

  async function patchSettings(request) {
    return exclusive(async () => {
      const [toml, schemaState, identity] = await Promise.all([
        readTomlState(), readSchema(), readIdentityState(),
      ]);
      checkCommonGuards(request, toml, schemaState, identity);

      const values = validateThemeSettingsPatch(schemaState.schema, request.values || {});
      const wantsIdentity = Object.keys(values).some((field) => IDENTITY_FIELDS.has(field));
      if (wantsIdentity) checkIdentityGuard(request, toml, schemaState, identity);

      const menusSubmitted = request.menus !== undefined;
      const menus = menusSubmitted ? validateMenus(request.menus) : null;

      assertValidToml(toml.raw, 'hugo.toml');
      let nextToml = toml.raw;
      const appliedFields = [];
      for (const [fieldPath, value] of Object.entries(values)) {
        nextToml = patchTomlValue(nextToml, fieldPath, value);
        appliedFields.push(fieldPath);
      }

      let menusApplied = false;
      if (menusSubmitted) {
        const before = parseToml(nextToml).menus;
        const patched = patchMenus(nextToml, menus);
        const after = parseToml(patched).menus;
        if (patched !== nextToml && !deepEqual(before, after)) {
          nextToml = patched;
          menusApplied = true;
        }
      }

      const candidate = assertValidToml(nextToml, 'hugo.toml');
      // 语义复核：已声明字段的期望值必须真实落到候选文件里，否则不写盘。
      for (const [fieldPath, value] of Object.entries(values)) {
        const actual = normalizeComparable(readPath(candidate, fieldPath));
        if (!deepEqual(actual, normalizeComparable(value))) {
          throw httpError(400, `设置写入后校验失败：${fieldPath} 的期望值与候选文件实际值不一致，本次没有写入任何文件。`);
        }
      }
      if (menusApplied) {
        const actualMenus = menusProjection(Array.isArray(candidate?.menus?.main) ? candidate.menus.main : []);
        if (!deepEqual(actualMenus, menusProjection(menus))) {
          throw httpError(400, '导航菜单写入后校验失败，本次没有写入任何文件。');
        }
      }

      const files = [];
      if (nextToml !== toml.raw) files.push({ target: tomlPath, content: nextToml });

      if (wantsIdentity) {
        const document = YAML.parseDocument(identity.raw, { prettyErrors: true, uniqueKeys: true });
        if (document.errors.length) throw httpError(400, `站点数据 YAML 无效：${document.errors[0].message}`);
        if (Object.hasOwn(values, 'params.avatar')) document.set('avatar', values['params.avatar']);
        if (Object.hasOwn(values, 'params.author')) document.set('author', values['params.author']);
        const nextSite = String(document);
        if (nextSite !== identity.raw) files.push({ target: siteDataFile, content: nextSite });
      }

      if (!files.length) {
        // changed:false 必须不触发重建，也不改任何字节。
        const projected = parseToml(nextToml);
        return {
          ok: true,
          changed: false,
          appliedFields: [],
          changedFiles: [],
          values: projected.values,
          menus: projected.menus,
          versions: versionsOf(toml.version, schemaState.version, identity.version),
        };
      }

      await fileTransaction.replaceFiles(files);
      const [nextTomlState, nextIdentity] = await Promise.all([readTomlState(), readIdentityState()]);
      const projected = parseToml(nextTomlState.raw);
      return {
        ok: true,
        changed: true,
        appliedFields,
        menusApplied,
        changedFiles: files.map((file) => path.relative(repoRoot, file.target).replaceAll('\\', '/')),
        values: projected.values,
        menus: projected.menus,
        versions: versionsOf(nextTomlState.version, schemaState.version, nextIdentity.version),
      };
    });
  }

  async function replaceSettingsRaw(request) {
    return exclusive(async () => {
      const [toml, schemaState, identity] = await Promise.all([
        readTomlState(), readSchema(), readIdentityState(),
      ]);
      if (typeof request.raw !== 'string' || request.raw.length > maxBodyBytes) {
        throw httpError(400, '配置内容无效。');
      }
      checkCommonGuards(request, toml, schemaState, identity);

      assertValidToml(request.raw, 'hugo.toml');

      // 原文路径沿用同一套作者/头像同步规则：只对候选 TOML 中真实改变的
      // params.author / params.avatar 同步 YAML，不因“原文保存”而跳过。
      const previous = parseToml(toml.raw).values;
      const next = parseToml(request.raw).values;
      const syncChanges = [];
      for (const [fieldPath, yamlKey] of IDENTITY_SYNC) {
        const after = next[fieldPath];
        if (after === undefined || deepEqual(previous[fieldPath], after)) continue;
        syncChanges.push({ field: fieldPath, yamlKey, value: after });
      }

      const files = [];
      if (request.raw !== toml.raw) files.push({ target: tomlPath, content: request.raw });

      if (syncChanges.length) {
        checkIdentityGuard(request, toml, schemaState, identity);
        const yamlDocument = YAML.parseDocument(identity.raw, { prettyErrors: true, uniqueKeys: true });
        if (yamlDocument.errors.length) throw httpError(400, `站点数据 YAML 无效：${yamlDocument.errors[0].message}`);
        for (const change of syncChanges) yamlDocument.set(change.yamlKey, change.value);
        const nextSite = String(yamlDocument);
        if (nextSite !== identity.raw) files.push({ target: siteDataFile, content: nextSite });
      }

      if (!files.length) {
        return {
          ok: true,
          changed: false,
          changedFiles: [],
          identitySync: [],
          versions: versionsOf(toml.version, schemaState.version, identity.version),
        };
      }
      await fileTransaction.replaceFiles(files);
      const [nextTomlState, nextIdentity] = await Promise.all([readTomlState(), readIdentityState()]);
      return {
        ok: true,
        changed: true,
        changedFiles: files.map((file) => path.relative(repoRoot, file.target).replaceAll('\\', '/')),
        identitySync: syncChanges.map((change) => ({ field: change.field, yamlKey: change.yamlKey })),
        versions: versionsOf(nextTomlState.version, schemaState.version, nextIdentity.version),
      };
    });
  }

  return {
    readFriends,
    readProfile,
    updateProfile,
    updateFriends,
    readSettings,
    patchSettings,
    replaceSettingsRaw,
    queueDepth: () => queueDepth,
  };
}
