import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { resolveInside } from '../fs/path-security.mjs';

const TOP_FILES = new Set([
  'server.mjs', 'package.json', 'package-lock.json', 'README.md', 'DESIGN.md',
  'CONTRIBUTING.md', 'LICENSE', '.gitignore', 'lilymap.config.schema.json', 'lilymap.json.example',
]);
const SOURCE_DIRECTORIES = ['src', 'test', 'scripts', 'public', '.github'];
const REQUIRED = ['server.mjs', 'package.json', 'public/index.html', 'src/domain/value.mjs'];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.admin-trash') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root);
  return files;
}

async function detectSourceRoot(repoRoot, adminDir) {
  for (const candidate of [path.join(repoRoot, 'tools', 'admin'), adminDir]) {
    if (!candidate) continue;
    const complete = (await Promise.all(REQUIRED.map((name) => exists(path.join(candidate, ...name.split('/')))))).every(Boolean);
    if (complete) return candidate;
  }
  throw new Error('当前 LilyMap 源码目录不完整，无法生成迁移包。');
}

function tarHeader(entryName, size) {
  const header = Buffer.alloc(512);
  header.write(entryName, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

export async function createLilyMapSourceArchive({ repoRoot, adminDir }) {
  const sourceRoot = await detectSourceRoot(repoRoot, adminDir);
  const names = [...TOP_FILES].filter((name) => fsSync.existsSync(path.join(sourceRoot, name)));

  for (const directory of SOURCE_DIRECTORIES) {
    const root = path.join(sourceRoot, directory);
    if (!(await exists(root))) continue;
    for (const file of await walkFiles(root)) {
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('源码导出路径越界。');
      names.push(relative);
    }
  }

  const uniqueNames = [...new Set(names)].sort();
  if (!uniqueNames.length) throw new Error('没有找到可导出的 LilyMap 源码。');

  const blocks = [];
  let totalBytes = 0;
  for (const name of uniqueNames) {
    const absolute = resolveInside(sourceRoot, name);
    if (!absolute) throw new Error(`源码导出路径不安全：${name}`);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`源码文件过大或类型无效：${name}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('LilyMap 源码总量超过 48 MB，已停止导出。');

    const data = await fs.readFile(absolute);
    const entryName = `tools/admin/${name}`;
    if (Buffer.byteLength(entryName, 'utf8') > 100) throw new Error(`源码路径过长，无法写入迁移包：${name}`);
    blocks.push(tarHeader(entryName, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }

  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
