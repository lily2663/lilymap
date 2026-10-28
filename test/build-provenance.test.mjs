// L0-02 验收：构建来源采集、bundle 注入、manifest 与来源诚实性。
//
// 关键判定（来自执行说明书 2.6 / 03.2）：
//   - "来源已证实"只能来自本次构建实际取得的 Git 信息
//   - 工作树有改动时必须标 unknown + 记录 diff 摘要，不得谎称是某个提交
//   - Git 不可用时降级为 unknown，而不是抛错
//   - 注入产物的信息不得含本机绝对路径
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { collectBuildInfo, publicBuildConstant } from '../scripts/build-info.mjs';
import { readEmbeddedBuildInfo } from '../src/domain/build-provenance.mjs';

const adminRoot = path.resolve(import.meta.dirname, '..');

test('collectBuildInfo 返回完整字段且类型正确', () => {
  const info = collectBuildInfo({ adminRoot });
  for (const key of [
    'schemaVersion', 'builtAt', 'appVersion', 'sourceSha', 'sourceBranch',
    'dirty', 'worktreeDiffSha256', 'lockSha256', 'themePin', 'nodeVersion',
    'esbuildVersion', 'pkgVersion', 'buildHost', 'provenance',
  ]) {
    assert.ok(Object.hasOwn(info, key), `缺少字段 ${key}`);
  }
  assert.equal(typeof info.appVersion, 'string');
  assert.ok(info.appVersion.length > 0, 'appVersion 不能为空');
  assert.match(info.nodeVersion, /^v\d+/);
  assert.equal(typeof info.provenance.known, 'boolean');
  assert.equal(typeof info.provenance.reason, 'string');
  assert.ok(info.provenance.reason.length > 0, 'provenance.reason 必须说明原因');
});

test('sourceSha 要么是合法 SHA、要么是 unknown，绝不瞎填', () => {
  const info = collectBuildInfo({ adminRoot });
  if (info.sourceSha === 'unknown') {
    assert.equal(info.dirty, 'unknown');
  } else {
    assert.match(info.sourceSha, /^[0-9a-f]{40}$/, `sourceSha 格式异常: ${info.sourceSha}`);
  }
});

test('工作树有改动时不得声称来源已证实', () => {
  const info = collectBuildInfo({ adminRoot });
  if (info.dirty === true) {
    assert.equal(info.provenance.known, false, 'dirty 工作树不得标为 known');
    assert.match(info.provenance.reason, /改动|dirty|补丁/, '原因应提到工作树改动');
    assert.match(String(info.worktreeDiffSha256), /^[0-9a-f]{64}$/, 'dirty 时必须记录 diff 摘要');
  }
  if (info.dirty === false) {
    assert.equal(info.provenance.known, true, '干净工作树应标为 known');
  }
});

test('lockSha256 是真实文件摘要', () => {
  const info = collectBuildInfo({ adminRoot });
  const lockPath = path.join(adminRoot, 'package-lock.json');
  const expected = createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
  assert.equal(info.lockSha256, expected);
});

test('themePin 来自 theme-compatibility.json', () => {
  const info = collectBuildInfo({ adminRoot });
  const pinPath = path.join(adminRoot, '.github', 'theme-compatibility.json');
  if (fs.existsSync(pinPath)) {
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    assert.equal(info.themePin, pin.ref);
  }
});

test('publicBuildConstant 不含本机绝对路径', () => {
  const info = collectBuildInfo({ adminRoot, repoRoot: path.resolve(adminRoot, '..', '..') });
  const published = publicBuildConstant(info);
  const blob = JSON.stringify(published);
  assert.ok(!Object.hasOwn(published, 'buildHost'), '可发布常量不得含 buildHost');
  // 不出现盘符路径
  assert.ok(!/[A-Za-z]:[\\/]/.test(blob), `可发布常量含绝对路径: ${blob.slice(0, 200)}`);
  // 不出现用户名目录
  assert.ok(!blob.includes('Users'), '可发布常量不应含用户目录');
});

test('readEmbeddedBuildInfo 在源码模式返回 null（不抛错）', () => {
  // 源码模式下 __LILYMAP_BUILD__ 未定义，必须安全降级
  const value = readEmbeddedBuildInfo();
  assert.equal(value, null, '源码模式应返回 null');
});

test('git 不可用时降级为 unknown 而不是抛错', () => {
  // 用一个不含 .git 的临时目录模拟便携环境
  const tmp = fs.mkdtempSync(path.join(adminRoot, '.cache-probe-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'probe', version: '9.9.9' }));
    const info = collectBuildInfo({ adminRoot: tmp });
    assert.equal(info.sourceSha, 'unknown');
    assert.equal(info.sourceBranch, 'unknown');
    assert.equal(info.dirty, 'unknown');
    assert.equal(info.provenance.known, false);
    assert.equal(info.appVersion, '9.9.9');
    // 缺 lock / pin 时也是 unknown，不抛错
    assert.equal(info.lockSha256, 'unknown');
    assert.equal(info.themePin, 'unknown');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundle 产物与 manifest 一致（若已构建）', () => {
  const bundlePath = path.join(adminRoot, 'server.cjs');
  const manifestPath = path.join(adminRoot, 'dist', 'build-manifest.json');
  if (!fs.existsSync(bundlePath) || !fs.existsSync(manifestPath)) {
    // 未构建时跳过，但必须明确标记，不能静默当通过
    console.log('SKIP: bundle 或 manifest 不存在（未运行 npm run build）');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const buf = fs.readFileSync(bundlePath);
  assert.equal(manifest.artifactBytes, buf.length, 'manifest 记录的字数应与产物一致');
  assert.equal(manifest.artifactSha256, createHash('sha256').update(buf).digest('hex'), 'manifest SHA-256 应与产物一致');
  assert.equal(manifest.artifact, 'server.cjs');
  assert.ok(manifest.build && typeof manifest.build === 'object', 'manifest 必须含 build 信息');
  assert.ok(!JSON.stringify(manifest.build).includes('buildHost'), 'manifest 的可发布部分不得含 buildHost');
});
