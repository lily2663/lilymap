import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// L2-01 的"与主题保持一致"验收。
//
// 这是本阶段唯一能把"两边语义一致"变成可复跑证据的用例：
// 它用真实 Hugo 0.165.0 + 真实主题 partial 构建 fixture，逐字比较
// source 与 text。缺失环境变量时按项目既有约定 skip，并在报告里写明"跳过"，
// 绝不默默当成通过。
const themed = process.env.LILY_TEST_THEME_PATH;
const hugo = process.env.LILY_TEST_HUGO_PATH;

test('L2-01: description sources and text match the real theme output', { skip: !themed || !hugo }, () => {
  const result = spawnSync(process.execPath, [path.resolve('scripts/verify-description-parity.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: path.resolve('.'),
    env: { ...process.env },
  });
  assert.equal(result.status, 0, `描述一致性问题：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /合成 fixture 一致：1[0-9]\/1[0-9]/, result.stdout);
  // 真实文章数量随内容变化，只要求"跑过且全部一致"
  assert.match(result.stdout, /真实文章一致：(\d+)\/\1/, result.stdout);
  assert.doesNotMatch(result.stdout, /DIFF/, result.stdout);
});

test('L2-01: the parity harness fails loudly instead of silently passing without theme env', { skip: !themed || !hugo }, () => {
  // 既然真正的验收依赖环境变量，就必须确认"变量缺失"时脚本是失败而不是绿。
  const result = spawnSync(process.execPath, [path.resolve('scripts/verify-description-parity.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: path.resolve('.'),
    env: { ...process.env, LILY_TEST_THEME_PATH: '', LILY_TEST_HUGO_PATH: '' },
  });
  assert.notEqual(result.status, 0, '缺环境变量时必须返回非 0');
  assert.match(result.stderr, /缺少 LILY_TEST_HUGO_PATH 或 LILY_TEST_THEME_PATH/);
});

test('L2-01: theme schema still declares the fields LilyMap now renders', { skip: !themed }, () => {
  // L2-02 的字段声明在 themes/ 下（Lead 的范围）。这里只做只读核对：
  // 若主题 schema 缺少 shareImage / rss.updated，LilyMap 会"不显示"而不报错，
  // 但本用例会失败并提示需要 Lead 补声明，避免双方以为已接通。
  const schemaPath = path.join(themed, 'theme-config.schema.json');
  assert.ok(fs.existsSync(schemaPath), `主题 schema 不存在：${schemaPath}`);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const paths = new Set();
  for (const section of schema.sections || []) {
    for (const field of section.fields || []) if (field?.path) paths.add(field.path);
  }
  const missing = ['params.shareImage', 'params.rss.updated', 'services.rss.limit'].filter((field) => !paths.has(field));
  assert.deepEqual(missing, [], `主题 schema 缺少这些字段（需 Lead 在 themes/lily-epitaph/theme-config.schema.json 声明）：${missing.join(', ')}`);
});
