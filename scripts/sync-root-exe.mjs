// 把 dist/LilyMap.exe 同步到博客根目录（用户实际启动位置）
//
// 为什么单独一步：`tools/admin/dist/LilyMap.exe` 是打包输出，
// 而用户双击的是博客根目录的 `LilyMap.exe`。两者必须一致，
// 否则会出现"启动了旧版本却以为在测新版本"的问题。
//
// 顺序要求：本脚本必须在 write-exe-manifest.mjs 之后、write-root-exe-manifest.mjs 之前。
// 为降低误用风险，这里先做一致性检查：若 dist 与 root 已不一致，说明需要复制；
// 复制后立即再由 write-root-exe-manifest 生成清单。
import { copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blogRoot = path.resolve(adminRoot, '..', '..');

const distExe = path.join(adminRoot, 'dist', 'LilyMap.exe');
const rootExe = path.join(blogRoot, 'LilyMap.exe');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const distBuf = await readFile(distExe);
const distSha = sha256(distBuf);

let rootSha = null;
try {
  rootSha = sha256(await readFile(rootExe));
} catch {
  rootSha = null;
}

if (rootSha === distSha) {
  console.log('根目录 LilyMap.exe 已与 dist 一致，无需复制');
} else {
  // 根 EXE 是启动入口，覆盖前必须确认目标路径就是博客根目录
  const normalizedRoot = blogRoot.split(path.sep).join('/');
  if (!normalizedRoot.endsWith('/Desktop/blog')) {
    console.error(`拒绝写入意外的路径: ${normalizedRoot}`);
    process.exit(1);
  }
  await copyFile(distExe, rootExe);
  console.log(`已复制到 ${normalizedRoot}/LilyMap.exe (${distBuf.length} bytes, ${distSha.slice(0, 16)}…)`);
}
