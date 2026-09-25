import { promises as fs } from 'node:fs';
import path from 'node:path';

import { formatYamlValue, parseFrontMatter } from '../domain/front-matter.mjs';
import { safeSlug } from '../domain/slug.mjs';

function imageReferences(raw) {
  return [...raw.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1])
    .filter((reference) => !/^https?:|^\//i.test(reference));
}

function importFileName(name) {
  return String(name || '').replaceAll('\\', '/').split('/').filter(Boolean);
}

export function createImportPlanner({
  repoRoot,
  uploadImageExtensions,
  hasExpectedImageSignature,
  httpError,
  now = () => new Date(),
}) {
  async function validateImportImageFile(diskPath) {
    const extension = path.extname(diskPath).toLowerCase();
    if (!uploadImageExtensions.has(extension)) throw new Error(`导入图片格式不受支持：${path.basename(diskPath)}。`);
    const stat = await fs.stat(diskPath);
    if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error(`导入图片过大或不是普通文件：${path.basename(diskPath)}。`);
    const bytes = await fs.readFile(diskPath);
    if (!hasExpectedImageSignature(bytes, extension)) throw new Error(`导入图片内容与扩展名不匹配或已损坏：${path.basename(diskPath)}。`);
  }

  return async function prepareImport(request) {
    const files = Array.isArray(request.files) ? request.files : [];
    const markdown = files.filter((file) => /\.md(?:own)?$/i.test(file.name || '') || /\.markdown$/i.test(file.name || ''));
    if (markdown.length !== 1) throw new Error('一次导入请选择一个 Markdown 文件（可同时包含它的图片目录）。');

    const source = markdown[0];
    const raw = Buffer.from(String(source.content || ''), 'base64').toString('utf8').replace(/^\uFEFF/, '');
    const parsed = parseFrontMatter(raw);
    const fileStem = path.basename(source.name, path.extname(source.name));
    const title = parsed.frontMatter.title || request.title || fileStem;
    const inferredSlug = String(title || fileStem).trim().toLowerCase().replace(/\s+/g, '-');
    const slug = safeSlug(parsed.frontMatter.slug || request.slug || inferredSlug || fileStem);
    if (!slug) throw new Error('无法生成安全的 Slug。');

    const sourceParts = importFileName(source.relativePath || source.name);
    const sourceDirectory = sourceParts.slice(0, -1).join('/');
    const references = imageReferences(parsed.body);
    const absolutePattern = /^(?:[A-Za-z]:[\\/]|\\\\)/;
    const rewrites = [];
    const staticCopies = [];
    const diskAssets = [];

    for (const reference of [...new Set(references)]) {
      if (!absolutePattern.test(reference)) continue;
      let diskPath = null;
      try {
        const candidate = path.resolve(reference);
        if ((await fs.stat(candidate)).isFile()) diskPath = candidate;
      } catch {}
      if (!diskPath) {
        rewrites.push({ from: reference, to: path.basename(reference.replaceAll('\\', '/')) });
        continue;
      }

      const relativeToRoot = path.relative(repoRoot, diskPath);
      const inRepo = relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
      const normalized = inRepo ? relativeToRoot.replaceAll('\\', '/') : '';
      if (inRepo && normalized.startsWith('static/')) {
        rewrites.push({ from: reference, to: `/${normalized.slice('static/'.length)}` });
      } else if (inRepo && normalized.startsWith('assets/')) {
        await validateImportImageFile(diskPath);
        staticCopies.push({ from: diskPath, to: normalized.replace(/^assets\//, 'static/assets/') });
        rewrites.push({ from: reference, to: `/${normalized}` });
      } else {
        await validateImportImageFile(diskPath);
        const base = path.basename(diskPath);
        if (!diskAssets.some((asset) => asset.diskPath === diskPath)) {
          diskAssets.push({ name: base, diskPath, parts: [base], targetParts: [base] });
        }
        rewrites.push({ from: reference, to: base });
      }
    }

    rewrites.sort((a, b) => b.from.length - a.from.length);
    let rewritten = raw;
    for (const rewrite of rewrites) rewritten = rewritten.split(rewrite.from).join(rewrite.to);

    const referencesClean = references.map((reference) => reference.replace(/^\.\//, ''));
    const bundleRefs = [];
    for (const reference of referencesClean) {
      const rewrite = rewrites.find((item) => item.from === reference);
      const effective = rewrite ? rewrite.to : reference;
      if (!/^(?:https?:)?\/\//i.test(effective) && !effective.startsWith('/')) bundleRefs.push(effective);
    }

    const referenceByBase = new Map();
    for (const reference of bundleRefs) {
      const base = reference.split('/').pop();
      if (base && !referenceByBase.has(base)) referenceByBase.set(base, reference);
    }

    const selected = files.filter((file) => file !== source).map((file) => {
      const parts = importFileName(file.relativePath || file.name);
      const relativeParts = sourceDirectory && parts.slice(0, sourceParts.length - 1).join('/') === sourceDirectory
        ? parts.slice(sourceParts.length - 1)
        : parts;
      let targetParts = relativeParts;
      const joined = relativeParts.join('/');
      if (!bundleRefs.includes(joined) && relativeParts.length === 1 && referenceByBase.has(relativeParts[0])) {
        targetParts = referenceByBase.get(relativeParts[0]).split('/');
      }
      return { ...file, parts, targetParts };
    });

    const selectedNames = new Set();
    for (const file of selected) {
      selectedNames.add(file.parts.join('/'));
      selectedNames.add(file.parts.at(-1));
      selectedNames.add(file.targetParts.join('/'));
    }
    for (const asset of diskAssets) selectedNames.add(asset.targetParts.join('/'));
    const missing = bundleRefs.filter((reference) => !selectedNames.has(reference) && !selectedNames.has(reference.split('/').pop()));

    const uniqueAssets = [];
    const assetTargets = new Map();
    for (const asset of [...selected, ...diskAssets]) {
      const targetParts = Array.isArray(asset.targetParts) ? asset.targetParts : [];
      const targetKey = targetParts.join('/').replaceAll('\\', '/').toLowerCase();
      if (!targetKey || targetKey === 'index.md') continue;
      const previous = assetTargets.get(targetKey);
      if (previous) {
        const sameDiskFile = previous.diskPath && asset.diskPath && path.resolve(previous.diskPath) === path.resolve(asset.diskPath);
        if (sameDiskFile) continue;
        throw httpError(409, `导入资源同名冲突：${targetParts.join('/')}。请重命名后再导入。`);
      }
      assetTargets.set(targetKey, asset);
      uniqueAssets.push(asset);
    }

    const stamp = now().toISOString();
    const content = parsed.rawFrontMatter ? rewritten : `---
title: ${formatYamlValue(title)}
date: ${stamp}
lastmod: ${stamp}
slug: ${formatYamlValue(slug)}
summary: ""
tags: []
categories: []
draft: ${request.draft === false ? 'false' : 'true'}
---

${rewritten}`;

    return {
      slug,
      title,
      raw: content,
      hasFrontMatter: Boolean(parsed.rawFrontMatter),
      sourceDirectory,
      assets: uniqueAssets,
      references,
      missing,
      rewrites,
      staticCopies,
      changes: [],
    };
  };
}
