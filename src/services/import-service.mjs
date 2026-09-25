import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveInside } from '../fs/path-security.mjs';

export function createImportService({
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
  fsApi = fs,
}) {
  const exists = async (target) => {
    try { await fsApi.access(target); return true; } catch { return false; }
  };
  const inside = (root, candidate) => resolveInside(root, candidate);
  const relativeToRepo = (target) => path.relative(repoRoot, target).split(path.sep).join('/');

  async function inspect(request) {
    const plan = await prepareImport(request);
    return {
      ...plan,
      raw: undefined,
      assetCount: plan.assets.length,
      rewriteCount: (plan.rewrites || []).length,
    };
  }

  async function commitPlan(plan) {
    const destination = path.join(contentRoot, 'posts', plan.slug);
    if (await exists(destination)) throw httpError(409, '目标文章目录已存在。');
    await fsApi.mkdir(destination, { recursive: true });

    const createdStatic = [];
    const publicSnapshots = [];
    try {
      for (const copy of plan.staticCopies || []) {
        const dest = inside(repoRoot, copy.to);
        if (!dest) throw new Error('资源路径不安全。');
        if (await exists(dest)) {
          const sourceBytes = await fsApi.readFile(copy.from);
          const currentBytes = await fsApi.readFile(dest);
          if (!currentBytes.equals(sourceBytes)) {
            throw httpError(409, `目标资源已存在且内容不同：${relativeToRepo(dest)}。`);
          }
        }
      }

      await atomicWrite(path.join(destination, 'index.md'), plan.raw, { schedule: false });

      for (const asset of plan.assets) {
        const relative = asset.targetParts.join('/');
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('资源路径不安全。');
        const target = inside(destination, relative);
        if (!target || !uploadImageExtensions.has(path.extname(target).toLowerCase())) continue;
        const bytes = asset.diskPath
          ? await fsApi.readFile(asset.diskPath)
          : Buffer.from(String(asset.content || ''), 'base64');
        if (!hasExpectedImageSignature(bytes, path.extname(target))) {
          throw new Error(`图片 ${path.basename(target)} 的内容与扩展名不匹配或已损坏。`);
        }
        await atomicCreate(target, bytes);
      }

      for (const copy of plan.staticCopies || []) {
        const dest = inside(repoRoot, copy.to);
        if (!dest) continue;
        const copyResult = await copyWithoutClobber(copy.from, dest);
        if (copyResult === 'created') createdStatic.push(dest);

        const publicDest = path.join(repoRoot, 'public', ...copy.to.replace(/^static\//, '').split('/'));
        const previousPublic = await fsApi.readFile(publicDest)
          .then((bytes) => ({ existed: true, bytes }))
          .catch((error) => {
            if (error?.code === 'ENOENT') return { existed: false, bytes: null };
            throw error;
          });
        publicSnapshots.push({ target: publicDest, ...previousPublic });
        await atomicWrite(publicDest, await fsApi.readFile(copy.from), { schedule: false });
      }

      scheduleBuild();
      return {
        ok: true,
        path: relativeToRepo(path.join(destination, 'index.md')),
        assetCount: plan.assets.length,
        missing: plan.missing,
        rewriteCount: (plan.rewrites || []).length,
      };
    } catch (error) {
      for (const snapshot of publicSnapshots.reverse()) {
        try {
          if (snapshot.existed) await atomicWrite(snapshot.target, snapshot.bytes, { schedule: false });
          else await fsApi.rm(snapshot.target, { force: true });
        } catch {}
      }
      await Promise.all(createdStatic.map((target) => fsApi.rm(target, { force: true }).catch(() => {})));
      const failed = path.join(trashRoot, `failed-import-${randomUUID()}`);
      await fsApi.mkdir(trashRoot, { recursive: true }).catch(() => {});
      await fsApi.rename(destination, failed).catch(async () => {
        await fsApi.rm(destination, { recursive: true, force: true }).catch(() => {});
      });
      throw error;
    }
  }

  async function importRequest(request) {
    const plan = await prepareImport(request);
    return commitPlan(plan);
  }

  return { inspect, commitPlan, importRequest };
}
