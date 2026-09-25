import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { resolveInside } from './src/fs/path-security.mjs';
import { createAtomicFileService } from './src/fs/atomic-files.mjs';
import { createFileTransactionService } from './src/fs/file-transaction.mjs';
import { createLilyMapSourceArchive } from './src/services/source-archive.mjs';
import { createBuildService } from './src/services/build-service.mjs';
import { createImportPlanner } from './src/services/import-planner.mjs';
import { createImportService } from './src/services/import-service.mjs';
import { createGitService } from './src/services/git-service.mjs';
import { createPublishService } from './src/services/publish-service.mjs';
import { createSiteSettingsService } from './src/services/site-settings-service.mjs';
import { createMediaService, mediaKind as classifyMedia } from './src/services/media-service.mjs';
import { createNetworkAdapter } from './src/services/network-adapter.mjs';
import { createNeteaseService } from './src/services/netease-service.mjs';
import { createLayoutModuleService } from './src/services/layout-module-service.mjs';
import { safeSlug } from './src/domain/slug.mjs';
import YAML from 'yaml';
import { formatYamlValue, parseFrontMatter, patchFrontMatter } from './src/domain/front-matter.mjs';
import { parseToml } from './src/domain/toml.mjs';
import { decryptProtectedBody, encryptProtectedBody } from './src/domain/protected-content.mjs';
import { isObject, parseYaml } from './src/domain/value.mjs';
import { normalizeLayout, normalizeModuleManifest, parseLayout, serializeLayout, validateLayoutAgainstRegistry } from './src/domain/layout.mjs';
import { createHttpPrimitives } from './src/http/primitives.mjs';
import { streamFile } from './src/http/static-files.mjs';
import { createImportRoutes } from './src/http/routes/import-routes.mjs';
import { createSettingsRoutes } from './src/http/routes/settings-routes.mjs';
import { createMediaRoutes } from './src/http/routes/media-routes.mjs';
import { createNeteaseRoutes } from './src/http/routes/netease-routes.mjs';
import { createPublishRoutes } from './src/http/routes/publish-routes.mjs';
import { createLayoutModuleRoutes } from './src/http/routes/layout-module-routes.mjs';
import { updateModulePlacement } from './src/domain/module-config.mjs';

// esbuild 打包成 cjs 后 __dirname 可用；dev 模式（node 直接跑 ESM）下 __dirname 不存在，
// 用 import.meta.url 兜底推导。
const adminDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
// 打包成 exe 后：静态界面与 server 代码一起被嵌入可执行文件快照（process.pkg 存在），
// 此时 adminDir 指向快照内虚拟路径。便携版优先把 exe 放在博客根目录；也可
// 在同目录 lilymap.json 中配置 repoRoot，或用 --project 指定另一个博客目录。
// esbuild 会把 `Boolean(process.pkg)` 常量折叠成 false 并 tree-shake 掉打包分支，
// 必须用括号访问 process["pkg"]，esbuild 无法静态分析，运行时才能正确判断是否打包。
const isPacked = typeof process !== 'undefined' && typeof process['pkg'] !== 'undefined';
const configDirectory = isPacked ? path.dirname(process.execPath) : adminDir;
const commandArguments = process.argv.slice(2);
function commandOption(name) {
  const index = commandArguments.indexOf(name);
  return index >= 0 ? String(commandArguments[index + 1] || '').trim() : '';
}
const explicitProject = commandOption('--project');
const shouldOpenBrowser = !commandArguments.includes('--no-open');
// 新包名使用 lilymap.json，同时兼容旧 Hugo Desk 安装，避免升级后丢失仓库定位。
const configPath = [path.join(configDirectory, 'lilymap.json'), path.join(configDirectory, 'hugo-desk.json')].find((candidate) => fsSync.existsSync(candidate)) || path.join(configDirectory, 'lilymap.json');
function resolveProjectPath(value) {
  if (!value || typeof value !== 'string') return '';
  return path.resolve(path.isAbsolute(value) ? value : path.join(configDirectory, value));
}
function isBlogRoot(value) {
  return Boolean(value) && fsSync.existsSync(path.join(value, 'hugo.toml')) && fsSync.existsSync(path.join(value, 'content'));
}
let repoRoot = '';
let configPort = 0;
let configProject = '';
let configOpenBrowser = true;
let configHugoPath = '';
try {
  const config = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
  configProject = String(config.repoRoot || '').trim();
  if (Number.isInteger(config.port) && config.port > 0) configPort = config.port;
  if (typeof config.openBrowser === 'boolean') configOpenBrowser = config.openBrowser;
  configHugoPath = String(config.hugoPath || '').trim();
} catch {}
const projectCandidates = [
  resolveProjectPath(explicitProject),
  resolveProjectPath(configProject),
  isPacked ? configDirectory : path.resolve(adminDir, '..', '..'),
];
repoRoot = projectCandidates.find(isBlogRoot) || '';
if (!repoRoot) throw new Error(`未找到 Hugo 博客项目。请把 LilyMap.exe 放入含 hugo.toml 与 content 的博客目录，或在 ${configPath} 设置 repoRoot，也可使用 --project "博客目录"。`);
const openBrowserOnStart = shouldOpenBrowser && configOpenBrowser;
const port = Number(process.env.ADMIN_PORT || configPort || 5174);
const blogPort = Number(process.env.BLOG_PORT || 1414);
function resolveToolPath(value) {
  if (!value) return '';
  return path.resolve(path.isAbsolute(value) ? value : path.join(repoRoot, value));
}
function detectThemeRoot(root) {
  const configured = String(process.env.LILY_THEME_PATH || '').trim();
  if (configured) {
    const absolute = path.resolve(path.isAbsolute(configured) ? configured : path.join(root, configured));
    if (fsSync.existsSync(path.join(absolute, 'theme-config.schema.json'))) return absolute;
  }
  let themeName = '';
  try {
    const config = fsSync.readFileSync(path.join(root, 'hugo.toml'), 'utf8');
    themeName = config.match(/^\s*theme\s*=\s*"([^"]+)"\s*$/m)?.[1] || '';
  } catch {}
  const candidates = [themeName, 'lily-epitaph'].filter(Boolean).map((name) => path.join(root, 'themes', name));
  for (const candidate of candidates) if (fsSync.existsSync(path.join(candidate, 'theme-config.schema.json'))) return candidate;
  try {
    const themes = fsSync.readdirSync(path.join(root, 'themes'), { withFileTypes: true });
    const compatible = themes.find((entry) => entry.isDirectory() && fsSync.existsSync(path.join(root, 'themes', entry.name, 'theme-config.schema.json')));
    if (compatible) return path.join(root, 'themes', compatible.name);
  } catch {}
  return candidates[0] || path.join(root, 'themes', 'lily-epitaph');
}
const contentRoot = path.join(repoRoot, 'content');
const staticRoot = path.join(repoRoot, 'static');
const siteAssetsRoot = path.join(staticRoot, 'assets');
const themeRoot = detectThemeRoot(repoRoot);
const themeName = path.basename(themeRoot);
const builtInLayoutsRoot = path.join(themeRoot, 'data', 'lily', 'layouts');
const userLayoutsRoot = path.join(repoRoot, 'data', 'lily', 'layouts');
const builtInModulesRoot = path.join(themeRoot, 'data', 'lily', 'modules');
const userModulesRoot = path.join(repoRoot, 'data', 'lily', 'modules');
const drawersFile = path.join(repoRoot, 'data', 'lily', 'drawers.yaml');
const siteDataFile = path.join(repoRoot, 'data', 'site.yaml');
const publicRoot = isPacked ? path.join(__dirname, 'public') : path.join(adminDir, 'public');
// Hugo 默认输出目录。dev server 从磁盘 serving，删除/重命名文章后旧的
// public 页面文件不会被自动清理，若不删会一直命中残留 HTML。
const hugoPublicRoot = path.join(repoRoot, 'public');
const trashRoot = path.join(repoRoot, '.admin-trash');
const bundledHugoExecutable = path.join(repoRoot, '.tools', 'hugo-0.165.0', 'hugo.exe');
const configuredHugoExecutable = resolveToolPath(process.env.LILY_HUGO_PATH || configHugoPath);
const hugoExecutable = configuredHugoExecutable && fsSync.existsSync(configuredHugoExecutable)
  ? configuredHugoExecutable : fsSync.existsSync(bundledHugoExecutable) ? bundledHugoExecutable : 'hugo';
const hugoSource = hugoExecutable === 'hugo' ? '系统 PATH' : hugoExecutable === bundledHugoExecutable ? '项目内置' : '本机配置';
const maxBodyBytes = 8 * 1024 * 1024;
const maxMediaBodyBytes = 160 * 1024 * 1024;
const maxDecodedImageBytes = 64 * 1024 * 1024;
const { adminHostAllowed, adminOriginAllowed, fail, hasExpectedImageSignature, httpError, readBody, send, staticSecurityHeaders } = createHttpPrimitives({
  port,
  maxBodyBytes,
  maxDecodedImageBytes,
});
// lilymap 管理的图片一律限制为栅格格式。SVG 是可执行文档，和管理 API
// 同源时会扩大本地 XSS 攻击面；已有的主题 SVG 仍可由静态站点正常使用。
const uploadImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const prepareImport = createImportPlanner({ repoRoot, uploadImageExtensions, hasExpectedImageSignature, httpError });
const uploadVideoExtensions = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi']);
const browserVideoExtensions = new Set(['.mp4', '.webm']);
const mediaTargetNames = new Map([
  ['welcome', 'day'],
  ['night', 'night'],
]);
const mediaKind = (target) => classifyMedia(target, uploadImageExtensions, uploadVideoExtensions);

// 管理端的状态必须反映真实进程，而不是根据“服务启动过”猜测。状态对象只
// 保存低敏感、有限长度的诊断信息，供概览页和版本页展示。
const previewState = {
  status: 'starting',
  error: '',
  startedAt: null,
  stoppedAt: null,
};
function lanPreviewAddresses() {
  const virtual = /radmin|vethernet|virtual|vmware|loopback|tailscale/i;
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const value = address.address;
      const isPrivate = /^10\./.test(value)
        || /^192\.168\./.test(value)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
      if (!isPrivate) continue;
      const interfaceRank = /^(wlan|wi-?fi|无线)/i.test(name) ? 0 : virtual.test(name) ? 20 : 5;
      const addressRank = value.startsWith('192.168.') ? 0 : value.startsWith('10.') ? 1 : 2;
      const rank = interfaceRank + addressRank;
      candidates.push({ value, rank });
    }
  }
  return [...new Set(candidates.sort((a, b) => a.rank - b.rank).map((item) => item.value))];
}

function previewSnapshot() {
  const addresses = lanPreviewAddresses();
  return {
    ...previewState,
    url: `http://localhost:${blogPort}`,
    lanUrl: addresses[0] ? `http://${addresses[0]}:${blogPort}` : '',
    lanUrls: addresses.map((address) => `http://${address}:${blogPort}`),
  };
}

function inside(root, candidate) {
  return resolveInside(root, candidate);
}

function repoPath(relative, allowedRoots = [contentRoot]) {
  if (!relative || path.isAbsolute(relative)) return null;
  const target = path.resolve(repoRoot, relative);
  for (const root of allowedRoots) {
    const resolved = inside(root, path.relative(root, target));
    if (resolved) return resolved;
  }
  return null;
}

function managedResourcePath(relative) {
  const target = repoPath(relative, [siteAssetsRoot, path.join(contentRoot, 'posts')]);
  if (!target || !['image', 'video'].includes(mediaKind(target))) return null;
  if (target.startsWith(`${path.join(contentRoot, 'posts')}${path.sep}`)) {
    const parts = path.relative(path.join(contentRoot, 'posts'), target).split(path.sep);
    if (parts.length !== 2 || !uploadImageExtensions.has(path.extname(target).toLowerCase())) return null;
  }
  return target;
}

function relativeToRepo(target) { return path.relative(repoRoot, target).split(path.sep).join('/'); }

function publicPathForRepoFile(target) {
  const resolved = path.resolve(target);
  if (resolved === staticRoot || resolved.startsWith(`${staticRoot}${path.sep}`)) {
    const relative = path.relative(staticRoot, resolved).split(path.sep).join('/');
    return relative ? `/${relative}` : '/';
  }
  return null;
}

function canonicalAssetDirectory(rawArea = 'static/assets/img') {
  let normalized = String(rawArea || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  // 旧版 LilyMap 曾把 assets/ 当成可直接访问目录；继续接受旧输入，
  // 但统一重定向到 Hugo 真正公开的 static/assets/，杜绝“配置有 URL、线上无文件”。
  normalized = normalized.replace(/^static\//, '');
  if (normalized === 'assets') normalized = 'assets/img';
  if (!normalized.startsWith('assets/')) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || !/^[\p{L}\p{N}._-]+$/u.test(part))) return null;
  return inside(staticRoot, parts.join(path.sep));
}

function safeMediaStem(value, fallback = 'media') {
  const stem = path.parse(path.basename(String(value || ''))).name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return stem || fallback;
}

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

// 清理 Hugo 输出目录中某篇文章（post bundle 或单文件）对应的渲染产物。
// 依赖 permalink 结构为 /posts/{slug}/，与 hugo.toml 的 defaultContentLanguage 渲染一致。
async function cleanupHugoOutput(relativeBundle) {
  const slug = path.basename(relativeBundle);
  for (const leaf of [`index.html`, `index.xml`, `index.json`, `index.json.patch`]) {
    await fs.rm(path.join(hugoPublicRoot, 'posts', slug, leaf), { force: true }).catch(() => {});
  }
  await fs.rm(path.join(hugoPublicRoot, 'posts', slug), { recursive: true, force: true }).catch(() => {});
}

async function walk(root, predicate = () => true) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'public' || entry.name === '.admin-trash') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && predicate(full)) entries.push(full);
    }
  }
  await visit(root);
  return entries;
}

function versionFor(raw, stat) { return `${stat.size}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`; }

const { git, gitNetwork, systemGitProxy, safeGitFailure, gitChanges } = createGitService({ repoRoot });

// 博客预览由 admin server 自己托管 public/（见底部 blogServer），
// 不再探测外部 hugo server，因此恒为运行中。
const blogHost = process.env.BLOG_HOST || '0.0.0.0';

async function blogStatus() {
  const running = previewState.status === 'running';
  const ready = running && await exists(path.join(hugoPublicRoot, 'index.html'));
  return { ...previewSnapshot(), running, ready };
}

async function articleRecord(file, changes) {
  const raw = await fs.readFile(file, 'utf8');
  const stat = await fs.stat(file);
  const { frontMatter, body } = parseFrontMatter(raw);
  const relative = relativeToRepo(file);
  const bundle = path.basename(file).toLowerCase() === 'index.md';
  const params = frontMatter.params && typeof frontMatter.params === 'object' ? frontMatter.params : {};
  const change = changes.find((item) => item.path === relative || item.path.endsWith(`/${relative}`));
  return {
    path: relative,
    fileName: path.basename(file),
    directory: relativeToRepo(path.dirname(file)),
    kind: bundle ? 'bundle' : 'file',
    title: frontMatter.title || path.basename(file, path.extname(file)),
    slug: frontMatter.slug || path.basename(bundle ? path.dirname(file) : file, path.extname(file)),
    date: frontMatter.date || '', lastmod: frontMatter.lastmod || '', draft: frontMatter.draft === true,
    tags: Array.isArray(frontMatter.tags) ? frontMatter.tags : [], categories: Array.isArray(frontMatter.categories) ? frontMatter.categories : [],
    description: frontMatter.description || frontMatter.summary || '', summary: frontMatter.summary || '', cover: frontMatter.cover || frontMatter.image || '',
    legacyId: params.legacyId || frontMatter.legacyId || '', protected: params.protected === true || frontMatter.protected === true,
    wordCount: body.trim() ? body.trim().split(/\s+/).length : 0, size: stat.size, modifiedAt: stat.mtime.toISOString(),
    git: change?.status || '', version: versionFor(raw, stat), frontMatter,
  };
}

async function listPosts(changes = null) {
  const currentChanges = changes || await gitChanges();
  const files = await walk(contentRoot, (file) => /\.md$/i.test(file));
  const posts = await Promise.all(files.map((file) => articleRecord(file, currentChanges)));
  return posts.sort((a, b) => String(b.lastmod || b.date || b.modifiedAt).localeCompare(String(a.lastmod || a.date || a.modifiedAt)));
}

async function readDrawers() {
  if (!(await exists(drawersFile))) return { drawers: [], version: '' };
  const raw = await fs.readFile(drawersFile, 'utf8');
  const data = parseYaml(raw, '分类抽屉');
  if (!Array.isArray(data.drawers)) throw httpError(500, '分类抽屉文件无效：drawers 必须是数组。');
  const stat = await fs.stat(drawersFile);
  return { drawers: data.drawers, version: versionFor(raw, stat) };
}

function validateDrawers(value, posts) {
  if (!Array.isArray(value) || value.length > 100) throw httpError(400, '抽屉数量不能超过 100 个。');
  const available = new Set(posts.filter((post) => post.path.startsWith('content/posts/')).map((post) => post.path));
  const ids = new Set();
  return value.map((drawer, index) => {
    if (!isObject(drawer)) throw httpError(400, `第 ${index + 1} 个抽屉无效。`);
    const id = String(drawer.id || '').trim();
    const title = String(drawer.title || '').trim();
    const description = String(drawer.description || '').trim();
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || ids.has(id)) throw httpError(400, `第 ${index + 1} 个抽屉 ID 无效或重复。`);
    if (!title || title.length > 60 || description.length > 200) throw httpError(400, `抽屉 ${id} 的名称或说明长度无效。`);
    if (!Array.isArray(drawer.posts) || drawer.posts.length > 1000) throw httpError(400, `抽屉 ${id} 的文章列表无效。`);
    if (drawer.posts.some((postPath) => typeof postPath !== 'string' || !available.has(postPath))) throw httpError(400, `抽屉 ${id} 引用了不存在的文章。请先刷新页面。`);
    if (new Set(drawer.posts).size !== drawer.posts.length) throw httpError(400, `抽屉 ${id} 含有重复文章。`);
    ids.add(id);
    return { id, title, description, posts: drawer.posts };
  });
}

async function remapDrawerPostPath(previous, next = '') {
  if (!(await exists(drawersFile))) return;
  const current = await readDrawers();
  let changed = false;
  const drawers = current.drawers.map((drawer) => {
    const original = Array.isArray(drawer.posts) ? drawer.posts : [];
    const posts = original.map((item) => item === previous ? next : item).filter(Boolean);
    if (posts.length !== original.length || posts.some((item, index) => item !== original[index])) changed = true;
    return { ...drawer, posts };
  });
  if (changed) await atomicWrite(drawersFile, YAML.stringify({ drawers }), { schedule: false });
}

// 构建管理：admin server 自己持有 Hugo 构建，不依赖外部 hugo server。
const {
  scheduleBuild,
  cancelScheduledBuild,
  runBuild,
  snapshot: buildSnapshot,
} = createBuildService({
  repoRoot,
  hugoExecutable,
  maxOutputBytes: 16 * 1024,
});

const { stageFile, atomicWrite, atomicCreate, copyWithoutClobber } = createAtomicFileService({
  scheduleBuild,
  httpError,
  relativeToRepo,
});

const importService = createImportService({
  repoRoot,
  contentRoot,
  trashRoot,
  uploadImageExtensions,
  prepareImport,
  hasExpectedImageSignature,
  atomicWrite,
  atomicCreate,
  copyWithoutClobber,
  scheduleBuild,
  httpError,
});

const mediaService = createMediaService({
  repoRoot,
  siteAssetsRoot,
  hugoPublicRoot,
  uploadImageExtensions,
  uploadVideoExtensions,
  mediaTargetNames,
  hasExpectedImageSignature,
  httpError,
  atomicCreate,
  scheduleBuild,
});
const {
  mediaToolsStatus,
  inspectMedia,
  syncStaticPreview,
  importWallpaperMedia,
  importUploadedVideo,
} = mediaService;

const network = createNetworkAdapter();

const fileTransaction = createFileTransactionService({
  stageFile,
  atomicWrite,
  scheduleBuild,
});

const layoutModules = createLayoutModuleService({
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
});

const netease = createNeteaseService({
  repoRoot,
  userLayoutsRoot,
  builtInLayoutsRoot,
  atomicWrite,
  runBuild,
  network,
  loadModuleRegistry: layoutModules.loadModuleRegistry,
  snapshotLayout: layoutModules.snapshotLayout,
});

const siteSettings = createSiteSettingsService({
  repoRoot,
  siteDataFile,
  themeRoot,
  fileTransaction,
  atomicWrite,
  httpError,
  maxBodyBytes,
});

const publishService = createPublishService({
  repoRoot,
  trashRoot,
  exists,
  atomicWrite,
  git,
  gitNetwork,
  safeGitFailure,
});

const importRoutes = createImportRoutes({ readBody, send, fail, importService });
const settingsRoutes = createSettingsRoutes({ readBody, send, fail, siteSettings });
const mediaRoutes = createMediaRoutes({
  readBody,
  send,
  fail,
  importWallpaperMedia,
  importUploadedVideo,
  maxMediaBodyBytes,
});
const neteaseRoutes = createNeteaseRoutes({ readBody, send, fail, netease });
const publishRoutes = createPublishRoutes({
  repoRoot,
  readBody,
  send,
  fail,
  publishService,
  git,
  gitChanges,
  systemGitProxy,
  exists,
});
const layoutModuleRoutes = createLayoutModuleRoutes({ readBody, send, fail, layoutModules });

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !adminOriginAllowed(req)) {
    return fail(res, 403, '仅允许从本机 lilymap 页面发起写入请求。');
  }
  if (await importRoutes(req, res, url)) return;
  if (await settingsRoutes(req, res, url)) return;
  if (await mediaRoutes(req, res, url)) return;
  if (await neteaseRoutes(req, res, url)) return;
  if (await publishRoutes(req, res, url)) return;
  if (await layoutModuleRoutes(req, res, url)) return;
  if (req.method === 'GET' && pathname === '/api/posts') return send(res, 200, { posts: await listPosts() });
  if (req.method === 'GET' && pathname === '/api/admin/export') {
    const archive = await createLilyMapSourceArchive({ repoRoot, adminDir });
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="lilymap-source.tar.gz"', 'content-length': archive.length, 'cache-control': 'no-store' });
    res.end(archive);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/drawers') return send(res, 200, await readDrawers());
  if (req.method === 'PUT' && pathname === '/api/drawers') {
    const request = JSON.parse((await readBody(req)).toString('utf8'));
    const current = await readDrawers();
    if (request.version !== current.version) return fail(res, 409, '抽屉已在别处修改，请刷新后重试。');
    const drawers = validateDrawers(request.drawers, await listPosts());
    await atomicWrite(drawersFile, YAML.stringify({ drawers }));
    return send(res, 200, { ok: true, ...await readDrawers() });
  }
  if (req.method === 'GET' && pathname === '/api/post') {
    const target = repoPath(url.searchParams.get('path'));
    if (!target || !(await exists(target)) || !/\.md$/i.test(target)) return fail(res, 404, '文章不存在。');
    const raw = await fs.readFile(target, 'utf8'); const stat = await fs.stat(target);
    return send(res, 200, { raw, version: versionFor(raw, stat), article: await articleRecord(target, await gitChanges()) });
  }
  if (req.method === 'PUT' && pathname === '/api/post') {
    const target = repoPath(url.searchParams.get('path'));
    if (!target || !(await exists(target)) || !/\.md$/i.test(target)) return fail(res, 404, '文章不存在。');
    const request = JSON.parse((await readBody(req)).toString('utf8'));
    if (typeof request.raw !== 'string' || request.raw.length > maxBodyBytes) return fail(res, 400, 'Markdown 内容无效。');
    const previous = await fs.readFile(target, 'utf8'); const stat = await fs.stat(target);
    if (request.version && request.version !== versionFor(previous, stat)) return send(res, 409, { error: '文件已被 Typora 或其他程序修改，请先重新载入或比较。', currentVersion: versionFor(previous, stat) });
    await atomicWrite(target, request.raw.replace(/^\uFEFF/, ''));
    const savedRaw = await fs.readFile(target, 'utf8'); const savedStat = await fs.stat(target);
    return send(res, 200, { ok: true, version: versionFor(savedRaw, savedStat), article: await articleRecord(target, await gitChanges()) });
  }
  if (req.method === 'PATCH' && pathname === '/api/article') {
    const target = repoPath(url.searchParams.get('path'));
    if (!target || !(await exists(target)) || !/\.md$/i.test(target)) return fail(res, 404, '文章不存在。');
    const request = JSON.parse((await readBody(req)).toString('utf8'));
    const previous = await fs.readFile(target, 'utf8'); const stat = await fs.stat(target);
    if (request.version && request.version !== versionFor(previous, stat)) return send(res, 409, { error: '文件已被外部修改，请重新载入后再保存。' });
    if (Object.hasOwn(request.changes || {}, 'protected')) return fail(res, 400, '请使用加密文章操作；单独修改保护标记不会加密正文。');
    const allowed = ['title', 'date', 'lastmod', 'slug', 'summary', 'description', 'cover', 'draft', 'tags', 'categories'];
    const changes = Object.fromEntries(Object.entries(request.changes || {}).filter(([key]) => allowed.includes(key)));
    await atomicWrite(target, patchFrontMatter(previous, changes));
    const saved = await fs.readFile(target, 'utf8'); const savedStat = await fs.stat(target);
    return send(res, 200, { ok: true, version: versionFor(saved, savedStat), article: await articleRecord(target, await gitChanges()) });
  }
  if (req.method === 'POST' && pathname === '/api/protected') {
    const request = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    const target = repoPath(request.path, [path.join(contentRoot, 'posts')]);
    if (!target || path.basename(target).toLowerCase() !== 'index.md' || !(await exists(target))) return fail(res, 404, '文章不存在。');
    const raw = await fs.readFile(target, 'utf8');
    const stat = await fs.stat(target);
    if (request.version !== versionFor(raw, stat)) return fail(res, 409, '文章已被修改，请重新打开后再操作。');
    const password = typeof request.password === 'string' ? request.password : '';
    if (password.length < 8 || password.length > 256) return fail(res, 400, '密码长度须为 8 到 256 个字符。');
    const parsed = parseFrontMatter(raw);
    if (!parsed.rawFrontMatter) return fail(res, 400, '文章缺少 Front Matter。');
    const id = String(parsed.frontMatter.params?.commentId || path.basename(path.dirname(target)));
    if (!/^[\p{L}\p{N}._-]{1,100}$/u.test(id)) return fail(res, 400, '文章 ID 无效。');
    const privatePath = path.join(repoRoot, 'private-content', `${id}.md`);
    const payloadPath = path.join(staticRoot, 'protected', `${encodeURIComponent(id)}.json`);
    const secretsPath = path.join(repoRoot, '.secrets', 'protected-posts.json');
    if (request.action === 'encrypt') {
      if (parsed.frontMatter.params?.protected === true || await exists(privatePath) || await exists(payloadPath)) return fail(res, 409, '文章已受保护，或加密文件已存在。');
      if (!parsed.body.trim()) return fail(res, 400, '正文为空，无法加密。');
      const originalSecrets = await exists(secretsPath) ? await fs.readFile(secretsPath, 'utf8') : null;
      const secrets = originalSecrets ? JSON.parse(originalSecrets) : {};
      if (Object.hasOwn(secrets, id)) return fail(res, 409, '该文章 ID 已有密码记录。');
      const payload = encryptProtectedBody(id, parsed.body, password);
      const marked = patchFrontMatter(raw, { protected: true, commentId: id });
      const stub = marked.replace(/^(---\n[\s\S]*?\n---\n)[\s\S]*$/, '$1这是一篇受保护文章。\n');
      payload.publicStubHash = createHash('sha256').update(stub).digest('hex');
      await fs.mkdir(path.dirname(privatePath), { recursive: true });
      await fs.mkdir(path.dirname(secretsPath), { recursive: true });
      let wroteSecrets = false, createdPrivate = false, createdPayload = false;
      try {
        await atomicCreate(privatePath, raw);
        createdPrivate = true;
        await atomicCreate(payloadPath, `${JSON.stringify(payload)}\n`);
        createdPayload = true;
        await atomicWrite(secretsPath, `${JSON.stringify({ ...secrets, [id]: password }, null, 2)}\n`, { schedule: false });
        await fs.chmod(secretsPath, 0o600).catch(() => {});
        wroteSecrets = true;
        await atomicWrite(target, stub);
      } catch (error) {
        if (wroteSecrets) {
          if (originalSecrets == null) await fs.rm(secretsPath, { force: true }).catch(() => {});
          else await atomicWrite(secretsPath, originalSecrets, { schedule: false }).catch(() => {});
        }
        if (createdPrivate) await fs.rm(privatePath, { force: true }).catch(() => {});
        if (createdPayload) await fs.rm(payloadPath, { force: true }).catch(() => {});
        throw error;
      }
      return send(res, 200, { ok: true, note: '正文已转入本机私有目录；若旧版本曾公开，Git 历史中的明文仍需另外处理。' });
    }
    if (request.action === 'decrypt') {
      if (parsed.frontMatter.params?.protected !== true || !(await exists(payloadPath))) return fail(res, 409, '文章没有可用的加密内容。');
      const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8'));
      const body = decryptProtectedBody(payload, password, id);
      const unmarked = patchFrontMatter(raw, { protected: false });
      const originalSource = await exists(privatePath) ? await fs.readFile(privatePath, 'utf8') : null;
      const unchangedStub = payload.publicStubHash === createHash('sha256').update(raw).digest('hex');
      const restored = originalSource && unchangedStub
        ? originalSource
        : unmarked.replace(/^(---\n[\s\S]*?\n---\n)[\s\S]*$/, (_, header) => header + body);
      const archived = path.join(trashRoot, 'protected', `${randomUUID()}-${id}`);
      const archivedPrivate = path.join(archived, `${id}.md`);
      const archivedPayload = path.join(archived, `${encodeURIComponent(id)}.json`);
      const originalSecrets = await exists(secretsPath) ? await fs.readFile(secretsPath, 'utf8') : null;
      let movedPrivate = false;
      let movedPayload = false;
      let updatedSecrets = false;
      await fs.mkdir(archived, { recursive: true });
      try {
        if (await exists(privatePath)) {
          await fs.rename(privatePath, archivedPrivate);
          movedPrivate = true;
        }
        await fs.rename(payloadPath, archivedPayload);
        movedPayload = true;
        if (originalSecrets != null) {
          const secrets = JSON.parse(originalSecrets);
          delete secrets[id];
          await atomicWrite(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { schedule: false });
          await fs.chmod(secretsPath, 0o600).catch(() => {});
          updatedSecrets = true;
        }
        await atomicWrite(target, restored);
      } catch (error) {
        await atomicWrite(target, raw).catch(() => {});
        if (movedPayload) await fs.rename(archivedPayload, payloadPath).catch(() => {});
        if (movedPrivate) await fs.rename(archivedPrivate, privatePath).catch(() => {});
        if (updatedSecrets && originalSecrets != null) await atomicWrite(secretsPath, originalSecrets, { schedule: false }).catch(() => {});
        throw error;
      }
      return send(res, 200, { ok: true, note: '正文已恢复为公开内容，加密文件已移入回收区。' });
    }
    return fail(res, 400, '未知加密操作。');
  }
  if (req.method === 'POST' && pathname === '/api/posts') {
    const request = JSON.parse((await readBody(req)).toString('utf8'));
    const slug = safeSlug(request.slug || request.title);
    if (!slug) return fail(res, 400, 'Slug 只能包含正常文件名字符，且不能包含路径。');
    const directory = inside(path.join(contentRoot, 'posts'), slug);
    const target = directory && path.join(directory, 'index.md');
    if (!target || await exists(directory)) return fail(res, 409, '该文章路径已存在。');
    const archetype = await fs.readFile(path.join(repoRoot, 'archetypes', 'default.md'), 'utf8');
    const now = new Date().toISOString();
    const title = String(request.title || slug).trim().replaceAll('"', '\\"');
    const raw = archetype.replace(/\{\{ replace \.Name "-" " " \| title \}\}/g, title).replace(/\{\{ \.Date \}\}/g, now).replace(/\{\{ \.Name \}\}/g, slug);
    await fs.mkdir(directory, { recursive: true });
    await atomicWrite(target, raw);
    return send(res, 201, { ok: true, path: relativeToRepo(target) });
  }
  if (req.method === 'POST' && pathname === '/api/pages') {
    const request = JSON.parse((await readBody(req)).toString('utf8'));
    const slug = safeSlug(request.slug);
    const title = typeof request.title === 'string' ? request.title.trim() : '';
    if (!slug || !title || title.length > 120 || ['posts', 'tags', 'categories'].includes(slug.toLowerCase())) return fail(res, 400, '页面标题或路径无效。');
    const directory = inside(contentRoot, slug);
    if (!directory || await exists(directory)) return fail(res, 409, '该页面路径已存在。');
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, 'index.md');
    await atomicWrite(target, `---\n${YAML.stringify({ title, draft: true }).trimEnd()}\n---\n\n`);
    return send(res, 201, { ok: true, path: relativeToRepo(target) });
  }
  if (req.method === 'DELETE' && pathname === '/api/post') {
    const target = repoPath(url.searchParams.get('path'));
    if (!target || !(await exists(target))) return fail(res, 404, '文章不存在。');
    const source = path.basename(target).toLowerCase() === 'index.md' ? path.dirname(target) : target;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(trashRoot, `${stamp}-${path.basename(source)}`);
    await fs.mkdir(trashRoot, { recursive: true });
    // 同一卷内 rename 是原子移动，秒级完成；页面清理由 cleanupHugoOutput +
    // scheduleBuild 显式完成，不再依赖 watcher 感知目录删除（旧 cp+rm 全量复制太慢）。
    try {
      await fs.rename(source, destination);
    } catch {
      await fs.cp(source, destination, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
    }
    await cleanupHugoOutput(relativeToRepo(source));
    await remapDrawerPostPath(relativeToRepo(target));
    scheduleBuild();
    return send(res, 200, { ok: true, trashedTo: relativeToRepo(destination) });
  }
  if (req.method === 'POST' && pathname === '/api/post/rename') {
    const request = JSON.parse((await readBody(req)).toString('utf8'));
    const target = repoPath(request.path); const slug = safeSlug(request.slug);
    if (!target || !slug || path.basename(target).toLowerCase() !== 'index.md') return fail(res, 400, '仅支持重命名 Page Bundle，且 Slug 必须安全。');
    const sourceDirectory = path.dirname(target); const destination = path.join(path.dirname(sourceDirectory), slug);
    if (await exists(destination)) return fail(res, 409, '目标目录已存在。');
    await cleanupHugoOutput(relativeToRepo(sourceDirectory));
    await fs.rename(sourceDirectory, destination);
    await remapDrawerPostPath(relativeToRepo(target), relativeToRepo(path.join(destination, 'index.md')));
    scheduleBuild();
    return send(res, 200, { ok: true, path: relativeToRepo(path.join(destination, 'index.md')) });
  }
  if (req.method === 'POST' && pathname === '/api/post/upload') {
    const target = repoPath(url.searchParams.get('path'));
    const name = path.basename(url.searchParams.get('name') || '');
    if (!target || path.basename(target).toLowerCase() !== 'index.md' || !name || !uploadImageExtensions.has(path.extname(name).toLowerCase())) return fail(res, 400, '仅允许上传 PNG、JPG、WebP、GIF 或 AVIF 图片资源。');
    const bytes = await readBody(req, 12 * 1024 * 1024); const destination = path.join(path.dirname(target), name);
    if (!hasExpectedImageSignature(bytes, path.extname(name))) return fail(res, 400, '图片内容与扩展名不匹配或文件已损坏。');
    try { await atomicCreate(destination, bytes); }
    catch (error) { if (error.statusCode === 409) return fail(res, 409, error.message); throw error; }
    scheduleBuild();
    return send(res, 201, { ok: true, markdown: `![${path.parse(name).name}](${name})`, path: relativeToRepo(destination) });
  }
  if (req.method === 'POST' && pathname === '/api/asset/upload') {
    const name = path.basename(url.searchParams.get('name') || '');
    const area = String(url.searchParams.get('area') || 'static/assets/img');
    if (!name || !uploadImageExtensions.has(path.extname(name).toLowerCase())) return fail(res, 400, '仅允许上传 PNG、JPG、WebP、GIF 或 AVIF 图片资源。');
    const dirInRepo = canonicalAssetDirectory(area);
    if (!dirInRepo) return fail(res, 400, '站点资源统一写入 static/assets，请选择该目录下的安全子目录。');
    await fs.mkdir(dirInRepo, { recursive: true });
    const bytes = await readBody(req, 24 * 1024 * 1024);
    if (!hasExpectedImageSignature(bytes, path.extname(name))) return fail(res, 400, '图片内容与扩展名不匹配或文件已损坏。');
    const sourcePath = path.join(dirInRepo, name);
    await atomicCreate(sourcePath, bytes);
    const preview = await syncStaticPreview(sourcePath);
    return send(res, 201, { ok: true, path: publicPathForRepoFile(sourcePath), file: relativeToRepo(sourcePath), ...preview });
  }
  if (req.method === 'GET' && pathname === '/api/files') {
    const roots = [contentRoot, staticRoot, path.join(repoRoot, 'assets'), path.join(repoRoot, 'data')];
    const availableRoots = [];
    for (const root of roots) if (await exists(root)) availableRoots.push(root);
    const files = (await Promise.all(availableRoots.map(async (root) => walk(root, () => true)))).flat();
    const entries = await Promise.all(files.map(async (file) => {
      const stat = await fs.stat(file);
      const relative = relativeToRepo(file);
      return {
        path: relative,
        publicPath: publicPathForRepoFile(file),
        scope: relative.startsWith('static/') ? 'public' : relative.startsWith('assets/') ? 'pipeline' : relative.startsWith('content/') ? 'content' : 'data',
        kind: mediaKind(file),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        extension: path.extname(file).slice(1).toLowerCase(),
      };
    }));
    return send(res, 200, { files: entries.sort((a, b) => a.path.localeCompare(b.path)) });
  }
  if (['PUT', 'PATCH', 'DELETE'].includes(req.method) && pathname === '/api/file') {
    const target = managedResourcePath(url.searchParams.get('path'));
    if (!target || !(await exists(target)) || !(await fs.stat(target)).isFile()) return fail(res, 404, '可管理的图片或视频不存在。');
    if (req.method === 'PATCH') {
      const request = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      const name = String(request.name || '').trim();
      if (!name || path.basename(name) !== name || !/^[\p{L}\p{N}._-]+$/u.test(name) || path.extname(name).toLowerCase() !== path.extname(target).toLowerCase()) return fail(res, 400, '新文件名无效；请保持原扩展名。');
      const destination = path.join(path.dirname(target), name);
      if (await exists(destination)) return fail(res, 409, '新文件名已存在。');
      await fs.rename(target, destination);
      scheduleBuild();
      return send(res, 200, { ok: true, path: relativeToRepo(destination) });
    }
    const backup = path.join(trashRoot, 'resources', `${randomUUID()}-${path.basename(target)}`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    if (req.method === 'DELETE') {
      await fs.rename(target, backup);
      scheduleBuild();
      return send(res, 200, { ok: true, trashedTo: relativeToRepo(backup) });
    }
    const bytes = await readBody(req, mediaKind(target) === 'video' ? maxMediaBodyBytes : 24 * 1024 * 1024);
    if (mediaKind(target) === 'image' && !hasExpectedImageSignature(bytes, path.extname(target))) return fail(res, 400, '新图片内容与原扩展名不匹配。');
    if (mediaKind(target) === 'video') {
      if (path.extname(target).toLowerCase() !== '.mp4') return fail(res, 400, '视频替换目前只支持 MP4；其他格式可先上传新文件。');
      const probeFile = path.join(trashRoot, 'resources', `${randomUUID()}.mp4`);
      await fs.writeFile(probeFile, bytes, { flag: 'wx' });
      try { await inspectMedia(probeFile); } finally { await fs.rm(probeFile, { force: true }); }
    }
    await fs.rename(target, backup);
    try { await atomicWrite(target, bytes); }
    catch (error) { await fs.rename(backup, target).catch(() => {}); throw error; }
    return send(res, 200, { ok: true, backup: relativeToRepo(backup) });
  }
  if (req.method === 'GET' && pathname === '/api/git/diff') {
    const target = url.searchParams.get('path');
    const args = target && !path.isAbsolute(target) && !target.includes('..') ? ['diff', '--', target] : ['diff', '--stat'];
    const result = await git(args); return send(res, 200, { diff: result.stdout || result.stderr, code: result.code });
  }
  if (req.method === 'POST' && pathname === '/api/build') {
    cancelScheduledBuild();
    const result = await runBuild(true, 'manual');
    return send(res, result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      error: result.code === 0 ? undefined : 'Hugo 构建失败。',
      ...result,
    });
  }
  return fail(res, 404, '未知 API。');
}

// 打包后 public 位于 exe 快照；源码模式从 tools/admin/public 读取。最后一个候选
// 兼容旧版便携包，便于仍与源码项目放在一起的用户完成升级。
const publicCandidates = [publicRoot, path.join(repoRoot, 'tools', 'admin', 'public')].filter(Boolean);
const server = createServer(async (req, res) => {
  try {
    if (!adminHostAllowed(req)) return fail(res, 403, '管理端只接受 localhost 或 127.0.0.1 请求。');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    let target = null;
    // Admin image previews: public site paths (/assets/..., /content/...,
    // /<theme-name>/...) resolve against repo static/, theme static/ and the
    // repo root so <img> tags render on the admin origin without a build.
    if (new RegExp(`^(assets|content|${themeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/`).test(requested)) {
      const previewRoots = [path.join(repoRoot, 'static'), path.join(themeRoot, 'static'), repoRoot];
      for (const root of previewRoots) {
        const candidate = inside(root, decodeURIComponent(requested));
        if (candidate && await exists(candidate) && !(await fs.stat(candidate)).isDirectory()) { target = candidate; break; }
      }
    }
    if (!target) for (const root of publicCandidates) {
      const candidate = inside(root, decodeURIComponent(requested));
      if (candidate && await exists(candidate)) { target = candidate; break; }
    }
    if (!target) return fail(res, 404, '文件不存在。');
    await streamFile(req, res, target, { 'cache-control': 'no-store', ...staticSecurityHeaders(target) });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    fail(res, status, error.message || '服务器错误。');
  }
});

let browserOpened = false;
function openLocalPage(targetPort = port) {
  if (!openBrowserOnStart || browserOpened) return;
  browserOpened = true;
  const address = `http://localhost:${targetPort}/`;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) { console.error(`无法自动打开浏览器：${error.message}`); }
}
// 博客预览：admin server 直接托管 public/，不再需要外部 hugo server。
// 不终止外部 Hugo 进程，也不删除共享构建锁，避免干扰其他终端或项目。
scheduleBuild(600);

// 监听 content/data 的外部改动（如 Typora 保存），防抖后自动重建，
// 与原版 watch.js 的“边写边看”体验一致。static/ 不监听：站点图片上传走
// static→public 直拷即时可见，若再触发构建会拖慢上传体验。
function watchForChanges() {
  const roots = [contentRoot, path.join(repoRoot, 'data')];
  for (const root of roots) {
    if (!fsSync.existsSync(root)) continue;
    try {
      fsSync.watch(root, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const name = String(filename).replaceAll('\\', '/');
        if (name.startsWith('.admin-trash/') || name.includes('/.git/') || name.endsWith('.tmp')) return;
        scheduleBuild(600);
      });
    } catch {}
  }
}
watchForChanges();

const blogServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    let target = inside(hugoPublicRoot, decodeURIComponent(requested));
    if (target && (await exists(target)) && (await fs.stat(target)).isDirectory()) target = path.join(target, 'index.html');
    if (!target || !(await exists(target))) {
      // 本地预览也应与生产静态站一致：未知路径显示主题的 404，而不是裸文本。
      const notFound = path.join(hugoPublicRoot, '404.html');
      if (await exists(notFound)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(await fs.readFile(notFound));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not Found');
      }
      return;
    }
    await streamFile(req, res, target, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  } catch (error) { console.error('博客预览错误：', error.message); res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Server Error'); }
});
blogServer.on('listening', () => {
  previewState.status = 'running';
  previewState.error = '';
  previewState.startedAt = new Date().toISOString();
  previewState.stoppedAt = null;
  console.log(`Blog preview: http://localhost:${blogPort}/`);
  for (const address of lanPreviewAddresses()) console.log(`Phone preview: http://${address}:${blogPort}/`);
});
blogServer.on('close', () => {
  previewState.status = 'stopped';
  previewState.stoppedAt = new Date().toISOString();
});
blogServer.on('error', (error) => {
  previewState.status = 'error';
  previewState.error = error.message || '博客预览服务启动失败。';
  previewState.stoppedAt = new Date().toISOString();
  console.error(`博客预览端口 ${blogPort} 被占用：${error.message}（可设置 BLOG_PORT 换端口）`);
});
blogServer.listen(blogPort, blogHost);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`管理端口 ${port} 已被占用：请先关闭旧的 lilymap 窗口（或任务管理器结束残留 node.exe），也可设置 ADMIN_PORT 换端口。`);
    console.error(`若只是想打开管理页：http://localhost:${port}/ 可能已在运行。`);
    openLocalPage(port);
    blogServer.close(() => process.exit(0));
    return;
  } else {
    console.error(`管理服务启动失败：${error.message}`);
  }
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Lily Admin local mode: http://localhost:${port}/`);
  openLocalPage(port);
});
