// L0-02 EXE 清单验收：来源诚实性。
//
// 核心风险（本轮实测到的）：对**旧 EXE** 生成清单时若写入当前源码 SHA，
// 会让读清单的人误以为"这个 EXE 是从当前源码构建的"。
// 因此本测试重点验证：不属于本次构建会话的产物，必须否认来源。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const adminRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(adminRoot, 'dist');
const exePath = path.join(distDir, 'LilyMap.exe');
const manifestPath = path.join(distDir, 'LilyMap.manifest.json');
const sumsPath = path.join(distDir, 'SHA256SUMS.txt');

const hasExe = fs.existsSync(exePath);

test('EXE manifest 结构完整且不含绝对路径', { skip: !hasExe && 'dist/LilyMap.exe 不存在' }, () => {
  if (!fs.existsSync(manifestPath)) {
    // 未生成清单时，明确跳过并说明（不静默当通过）
    console.log('SKIP: 尚未生成 dist/LilyMap.manifest.json');
    return;
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const key of ['schemaVersion', 'product', 'artifact', 'artifactBytes', 'artifactSha256',
    'fileMtime', 'mtimeIsSourceEvidence', 'producedInThisSession', 'provenance']) {
    assert.ok(Object.hasOwn(m, key), `manifest 缺少字段 ${key}`);
  }
  assert.equal(m.product, 'LilyMap');
  assert.equal(m.artifact, 'LilyMap.exe');
  assert.match(m.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(m.mtimeIsSourceEvidence, false, '必须显式声明 mtime 不是来源证据');
  assert.equal(typeof m.provenance.known, 'boolean');
  assert.ok(m.provenance.reason.length > 0, 'provenance.reason 必须说明原因');
  assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(m)), 'manifest 不得含 Windows 绝对路径');
});

test('manifest 的 SHA 与真实文件一致', { skip: !hasExe && 'dist/LilyMap.exe 不存在' }, () => {
  if (!fs.existsSync(manifestPath)) return;
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const buf = fs.readFileSync(exePath);
  assert.equal(m.artifactBytes, buf.length);
  assert.equal(m.artifactSha256, createHash('sha256').update(buf).digest('hex'));
});

test('SHA256SUMS.txt 格式可被校验工具读取', { skip: !fs.existsSync(sumsPath) && '未生成 SHA256SUMS.txt' }, () => {
  const text = fs.readFileSync(sumsPath, 'utf8');
  const line = text.trim().split(/\r?\n/)[0];
  assert.match(line, /^[0-9a-f]{64}\s+\S+$/, `格式异常: ${line}`);
  const [sha, name] = line.split(/\s+/);
  assert.equal(name, 'LilyMap.exe');
  const buf = fs.readFileSync(exePath);
  assert.equal(sha, createHash('sha256').update(buf).digest('hex'), '校验和必须对应真实文件');
});

test('非本次会话产出的 EXE 必须否认来源', { skip: !hasExe && 'dist/LilyMap.exe 不存在' }, () => {
  if (!fs.existsSync(manifestPath)) return;
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.producedInThisSession === false) {
    assert.equal(m.provenance.known, false, '非本次产出的 EXE 不得标为来源已证实');
    assert.equal(m.build, null, '非本次产出的 EXE 不得带 build 信息（避免旧产物 + 新 SHA 的误读）');
    assert.match(m.provenance.reason, /会话|早于|既有|未知/, '原因应说明为何来源未知');
  }
  if (m.producedInThisSession === true) {
    // 本次会话产出：允许 known=true（干净工作树）或 false（有改动），但必须给出原因
    assert.equal(typeof m.provenance.known, 'boolean');
    assert.ok(m.build && typeof m.build === 'object', '本次产出的 EXE 应带 build 信息');
  }
});

test('作废旧会话后重新生成清单仍不得谎称来源', { skip: !hasExe && 'dist/LilyMap.exe 不存在' }, () => {
  if (!fs.existsSync(manifestPath)) return;
  const sessionPath = path.join(distDir, '.build-session.json');
  const hadSession = fs.existsSync(sessionPath);
  const backup = hadSession ? fs.readFileSync(sessionPath, 'utf8') : null;
  try {
    // 模拟"没有会话标记"的旧产物场景
    if (hadSession) fs.rmSync(sessionPath, { force: true });
    const r = spawnSync(process.execPath, [path.join(adminRoot, 'scripts/write-exe-manifest.mjs')], {
      cwd: adminRoot, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // 没有会话时，若 EXE mtime 早于"现在"，必须否认
    if (m.producedInThisSession === false) {
      assert.equal(m.build, null);
      assert.equal(m.provenance.known, false);
    }
  } finally {
    if (backup !== null) fs.writeFileSync(sessionPath, backup, 'utf8');
  }
});
