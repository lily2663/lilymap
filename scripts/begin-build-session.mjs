// 构建会话标记（L0-02）
//
// 在开始打包前写入 `dist/.build-session.json`。
// 目的：让"产物清单"能区分「本次构建的产物」与「工作区里遗留的旧文件」。
//
// 没有这个标记时，对旧 EXE 生成清单会把当前源码 SHA 错记成它的来源——
// 这是本轮实测到的真实风险，必须用机制阻断而不是靠人记得。
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { collectBuildInfo, publicBuildConstant } from './build-info.mjs';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(adminRoot, 'dist');

await mkdir(distDir, { recursive: true });

const info = collectBuildInfo({ adminRoot, repoRoot: path.resolve(adminRoot, '..', '..') });
const session = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  build: publicBuildConstant(info),
};
await writeFile(
  path.join(distDir, '.build-session.json'),
  `${JSON.stringify(session, null, 2)}\n`,
  'utf8',
);
console.log(`build session started at ${session.startedAt}`);
