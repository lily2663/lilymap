import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { validateFriends, validateProfile } from '../domain/profile.mjs';
import { validateMenus, validateThemeSettingsPatch } from '../domain/theme-config.mjs';
import { parseToml, patchMenus, patchTomlValue } from '../domain/toml.mjs';
import { parseYaml } from '../domain/value.mjs';

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

  async function readFriends() {
    const raw = await fs.readFile(siteDataFile, 'utf8');
    const site = parseYaml(raw, '站点数据');
    if (site.friends != null && !Array.isArray(site.friends)) throw new Error('站点数据中的 friends 必须是列表。');
    return { friends: site.friends || [], version: createHash('sha256').update(raw).digest('hex') };
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
      version: createHash('sha256').update(raw).digest('hex'),
    };
  }

  async function updateProfile(request) {
    const raw = await fs.readFile(siteDataFile, 'utf8');
    if (request.version !== createHash('sha256').update(raw).digest('hex')) {
      throw httpError(409, '个人资料已在别处修改，请刷新后重试。');
    }

    const profile = validateProfile(request.profile);
    const document = YAML.parseDocument(raw, { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length) throw httpError(400, `站点数据 YAML 无效：${document.errors[0].message}`);
    for (const [key, value] of Object.entries(profile)) document.set(key, value);

    const toml = await fs.readFile(tomlPath, 'utf8');
    await fileTransaction.replaceFiles([
      { target: siteDataFile, content: String(document) },
      { target: tomlPath, content: patchTomlValue(toml, 'params.author', profile.author) },
    ]);
    return { ok: true, ...(await readProfile()) };
  }

  async function updateFriends(request) {
    const raw = await fs.readFile(siteDataFile, 'utf8');
    const version = createHash('sha256').update(raw).digest('hex');
    if (request.version !== version) throw httpError(409, '友链配置已在别处修改，请刷新后重试。');

    const friends = validateFriends(request.friends);
    const document = YAML.parseDocument(raw, { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length) throw httpError(400, `站点数据 YAML 无效：${document.errors[0].message}`);
    document.set('friends', friends);
    await atomicWrite(siteDataFile, String(document));
    return { ok: true, ...(await readFriends()) };
  }

  async function readSettings() {
    const raw = await fs.readFile(tomlPath, 'utf8');
    const schema = JSON.parse(await fs.readFile(path.join(themeRoot, 'theme-config.schema.json'), 'utf8'));
    return { raw, ...parseToml(raw), schema };
  }

  async function patchSettings(request) {
    const schema = JSON.parse(await fs.readFile(path.join(themeRoot, 'theme-config.schema.json'), 'utf8'));
    const values = validateThemeSettingsPatch(schema, request.values || {});
    const menus = request.menus === undefined ? null : validateMenus(request.menus);

    let raw = await fs.readFile(tomlPath, 'utf8');
    for (const [fieldPath, value] of Object.entries(values)) raw = patchTomlValue(raw, fieldPath, value);
    if (menus) raw = patchMenus(raw, menus);

    const files = [{ target: tomlPath, content: raw }];
    const hasAvatar = Object.hasOwn(values, 'params.avatar');
    const hasAuthor = Object.hasOwn(values, 'params.author');
    if (hasAvatar || hasAuthor) {
      const siteRaw = await fs.readFile(siteDataFile, 'utf8');
      const document = YAML.parseDocument(siteRaw, { prettyErrors: true, uniqueKeys: true });
      if (document.errors.length) throw httpError(400, `站点数据 YAML 无效：${document.errors[0].message}`);
      if (hasAvatar) document.set('avatar', values['params.avatar']);
      if (hasAuthor) document.set('author', values['params.author']);
      files.push({ target: siteDataFile, content: String(document) });
    }

    await fileTransaction.replaceFiles(files);
    return { ok: true, ...parseToml(raw) };
  }

  async function replaceSettingsRaw(request) {
    if (typeof request.raw !== 'string' || request.raw.length > maxBodyBytes) {
      throw httpError(400, '配置内容无效。');
    }
    await fileTransaction.replaceFiles([{ target: tomlPath, content: request.raw }]);
    return { ok: true };
  }

  return {
    readFriends,
    readProfile,
    updateProfile,
    updateFriends,
    readSettings,
    patchSettings,
    replaceSettingsRaw,
  };
}
