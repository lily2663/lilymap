import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveInside } from '../fs/path-security.mjs';

export function createResourceService({
  repoRoot,
  contentRoot,
  staticRoot,
  siteAssetsRoot,
  trashRoot,
  uploadImageExtensions,
  mediaKind,
  hasExpectedImageSignature,
  atomicCreate,
  atomicWrite,
  scheduleBuild,
  syncStaticPreview,
  inspectMedia,
  fsApi = fs,
}) {
  const exists = async (target) => {
    try { await fsApi.access(target); return true; } catch { return false; }
  };
  const inside = (root, candidate) => resolveInside(root, candidate);
  const relativeToRepo = (target) => path.relative(repoRoot, target).split(path.sep).join('/');

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
    normalized = normalized.replace(/^static\//, '');
    if (normalized === 'assets') normalized = 'assets/img';
    if (!normalized.startsWith('assets/')) return null;
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some((part) => part === '.' || part === '..' || !/^[\p{L}\p{N}._-]+$/u.test(part))) return null;
    return inside(staticRoot, parts.join(path.sep));
  }

  function managedResourcePath(relative) {
    if (!relative || path.isAbsolute(relative)) return null;
    const target = path.resolve(repoRoot, relative);
    const allowedRoots = [siteAssetsRoot, path.join(contentRoot, 'posts')];
    if (!allowedRoots.some((root) => inside(root, path.relative(root, target)))) return null;
    if (!['image', 'video'].includes(mediaKind(target))) return null;
    const postsRoot = path.join(contentRoot, 'posts');
    if (target.startsWith(`${postsRoot}${path.sep}`)) {
      const parts = path.relative(postsRoot, target).split(path.sep);
      if (parts.length !== 2 || !uploadImageExtensions.has(path.extname(target).toLowerCase())) return null;
    }
    return target;
  }

  async function walk(root) {
    const entries = [];
    async function visit(directory) {
      for (const entry of await fsApi.readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'public' || entry.name === '.admin-trash') continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) entries.push(full);
      }
    }
    await visit(root);
    return entries;
  }

  async function listFiles() {
    const roots = [contentRoot, staticRoot, path.join(repoRoot, 'assets'), path.join(repoRoot, 'data')];
    const available = [];
    for (const root of roots) if (await exists(root)) available.push(root);
    const files = (await Promise.all(available.map(walk))).flat();
    const entries = await Promise.all(files.map(async (file) => {
      const stat = await fsApi.stat(file);
      const relative = relativeToRepo(file);
      return {
        path: relative,
        publicPath: publicPathForRepoFile(file),
        scope: relative.startsWith('static/') ? 'public'
          : relative.startsWith('assets/') ? 'pipeline'
            : relative.startsWith('content/') ? 'content'
              : 'data',
        kind: mediaKind(file),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        extension: path.extname(file).slice(1).toLowerCase(),
      };
    }));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function uploadAsset({ name, area, bytes }) {
    const safeName = path.basename(name || '');
    if (!safeName || !uploadImageExtensions.has(path.extname(safeName).toLowerCase())) {
      throw Object.assign(new Error('仅允许上传 PNG、JPG、WebP、GIF 或 AVIF 图片资源。'), { statusCode: 400 });
    }
    const dirInRepo = canonicalAssetDirectory(area);
    if (!dirInRepo) {
      throw Object.assign(new Error('站点资源统一写入 static/assets，请选择该目录下的安全子目录。'), { statusCode: 400 });
    }
    if (!hasExpectedImageSignature(bytes, path.extname(safeName))) {
      throw Object.assign(new Error('图片内容与扩展名不匹配或文件已损坏。'), { statusCode: 400 });
    }
    await fsApi.mkdir(dirInRepo, { recursive: true });
    const sourcePath = path.join(dirInRepo, safeName);
    await atomicCreate(sourcePath, bytes);
    const preview = await syncStaticPreview(sourcePath);
    return {
      path: publicPathForRepoFile(sourcePath),
      file: relativeToRepo(sourcePath),
      ...preview,
    };
  }

  async function mutateFile({ method, relativePath, name, bytes }) {
    const target = managedResourcePath(relativePath);
    if (!target || !(await exists(target)) || !(await fsApi.stat(target)).isFile()) {
      throw Object.assign(new Error('可管理的图片或视频不存在。'), { statusCode: 404 });
    }

    if (method === 'PATCH') {
      const nextName = String(name || '').trim();
      if (!nextName
        || path.basename(nextName) !== nextName
        || !/^[\p{L}\p{N}._-]+$/u.test(nextName)
        || path.extname(nextName).toLowerCase() !== path.extname(target).toLowerCase()) {
        throw Object.assign(new Error('新文件名无效；请保持原扩展名。'), { statusCode: 400 });
      }
      const destination = path.join(path.dirname(target), nextName);
      if (await exists(destination)) throw Object.assign(new Error('新文件名已存在。'), { statusCode: 409 });
      await fsApi.rename(target, destination);
      scheduleBuild();
      return { path: relativeToRepo(destination) };
    }

    const backup = path.join(trashRoot, 'resources', `${randomUUID()}-${path.basename(target)}`);
    await fsApi.mkdir(path.dirname(backup), { recursive: true });

    if (method === 'DELETE') {
      await fsApi.rename(target, backup);
      scheduleBuild();
      return { trashedTo: relativeToRepo(backup) };
    }

    if (method !== 'PUT') throw Object.assign(new Error('不支持的资源操作。'), { statusCode: 405 });
    const kind = mediaKind(target);
    if (kind === 'image' && !hasExpectedImageSignature(bytes, path.extname(target))) {
      throw Object.assign(new Error('新图片内容与原扩展名不匹配。'), { statusCode: 400 });
    }
    if (kind === 'video') {
      if (path.extname(target).toLowerCase() !== '.mp4') {
        throw Object.assign(new Error('视频替换目前只支持 MP4；其他格式可先上传新文件。'), { statusCode: 400 });
      }
      const probeFile = path.join(trashRoot, 'resources', `${randomUUID()}.mp4`);
      await fsApi.writeFile(probeFile, bytes, { flag: 'wx' });
      try { await inspectMedia(probeFile); }
      finally { await fsApi.rm(probeFile, { force: true }).catch(() => {}); }
    }

    await fsApi.rename(target, backup);
    try {
      await atomicWrite(target, bytes);
    } catch (error) {
      await fsApi.rename(backup, target).catch(() => {});
      throw error;
    }
    return { backup: relativeToRepo(backup) };
  }

  return { listFiles, uploadAsset, mutateFile };
}
