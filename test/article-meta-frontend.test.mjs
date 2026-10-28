import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTICLE_META_KEYS,
  DESCRIPTION_SOURCE_TEXT,
  collectMetaChanges,
  descriptionFields,
  inferDescriptionSource,
  metaSnapshot,
  refreshDescriptionHint,
} from '../public/js/features/article-meta.js';

// L2-01 前端：双描述字段分离 + 最小 diff。
// 只为两个描述输入框判断“改没改”是本次的核心缺陷修复，因此这里重点覆盖：
//   1) 缺省时不把回退值填进输入框；
//   2) 只提交变化键，空字符串算“清空”而不是“未设置”；
//   3) 409 时保留输入由调用方负责，本模块不得改写基线。

const ARTICLE = {
  title: '群友靶机 Demo',
  date: '2024-01-05T00:00:00+08:00',
  slug: 'demo',
  tags: ['靶机', '提权'],
  description: '',
  summary: '卡片摘要',
  cover: '',
  draft: false,
  effectiveDescription: '卡片摘要',
  descriptionSource: 'summary',
  protected: false,
};

test('article-meta: the baseline holds explicit values only, never the fallback text', () => {
  const baseline = metaSnapshot(ARTICLE);
  assert.equal(baseline.description, '', '回退值不能进入基线，否则会被当成已保存值');
  assert.equal(baseline.summary, '卡片摘要');
  assert.equal(baseline.date, '2024-01-05', '日期按 input[type=date] 的粒度比较');
  assert.deepEqual(baseline.tags, ['靶机', '提权']);
});

test('article-meta: no edit submits nothing', () => {
  const baseline = metaSnapshot(ARTICLE);
  assert.deepEqual(collectMetaChanges(baseline, metaSnapshot(ARTICLE)), {});
});

test('article-meta: editing description only submits description', () => {
  const baseline = metaSnapshot(ARTICLE);
  const current = { ...metaSnapshot(ARTICLE), description: '显式搜索简介' };
  assert.deepEqual(collectMetaChanges(baseline, current), { description: '显式搜索简介' });
});

test('article-meta: editing summary only submits summary', () => {
  const baseline = metaSnapshot({ ...ARTICLE, description: '原有描述' });
  const current = { ...metaSnapshot({ ...ARTICLE, description: '原有描述' }), summary: '新摘要' };
  assert.deepEqual(collectMetaChanges(baseline, current), { summary: '新摘要' });
});

test('article-meta: an empty string is an explicit clear, not "unset"', () => {
  const baseline = metaSnapshot({ ...ARTICLE, description: '原有描述' });
  const current = { ...metaSnapshot({ ...ARTICLE, description: '原有描述' }), description: '' };
  assert.deepEqual(collectMetaChanges(baseline, current), { description: '' },
    '清空描述必须能提交，否则用户无法撤回显式 description');
});

test('article-meta: only whitelisted keys are ever submitted', () => {
  const baseline = metaSnapshot(ARTICLE);
  const current = { ...metaSnapshot(ARTICLE), summary: '改', frontMatter: { hacked: true }, effectiveDescription: '不该提交' };
  const changes = collectMetaChanges(baseline, current);
  assert.deepEqual(Object.keys(changes), ['summary']);
  for (const key of Object.keys(changes)) assert.ok(ARTICLE_META_KEYS.includes(key));
});

test('article-meta: undefined means "not present in this form" and is skipped', () => {
  const baseline = metaSnapshot(ARTICLE);
  const changes = collectMetaChanges(baseline, { title: '改标题', description: undefined });
  assert.deepEqual(changes, { title: '改标题' });
});

test('article-meta: tags compare by content, not by reference', () => {
  const baseline = metaSnapshot(ARTICLE);
  assert.deepEqual(collectMetaChanges(baseline, { ...metaSnapshot(ARTICLE), tags: ['靶机', '提权'] }), {});
  assert.deepEqual(collectMetaChanges(baseline, { ...metaSnapshot(ARTICLE), tags: ['靶机'] }), { tags: ['靶机'] });
});

test('article-meta: draft false is compared by type, not truthiness', () => {
  const baseline = metaSnapshot({ ...ARTICLE, draft: true });
  const changes = collectMetaChanges(baseline, { ...metaSnapshot({ ...ARTICLE, draft: true }), draft: false });
  assert.deepEqual(changes, { draft: false }, 'false 必须被识别为变化');
});

test('article-meta: the rendered panel shows two separate inputs and never prefills the fallback', () => {
  const markup = descriptionFields(ARTICLE);
  assert.match(markup, /id="f-description"/);
  assert.match(markup, /id="f-summary"/);
  assert.match(markup, /搜索\/分享简介（description）/);
  assert.match(markup, /卡片摘要（summary）/);
  // description 输入框必须是空 value（ARTICLE.description 缺省）
  const descriptionInput = /<input id="f-description"[^>]*>/.exec(markup)[0];
  assert.match(descriptionInput, /value=""/, '缺省时不回填回退值');
  const summaryInput = /<input id="f-summary"[^>]*>/.exec(markup)[0];
  assert.match(summaryInput, /value="卡片摘要"/);
  // 回退信息以说明形式出现：summary 已在输入框里，因此只给出来源说明，不重复预览
  assert.match(markup, /当前使用：卡片摘要（summary）/);
  assert.doesNotMatch(markup, /回退文本预览/, 'summary 值已在输入框内，再预览一次是噪声');
  assert.match(markup, /description-source-hint/);
});

test('article-meta: auto-body fallback is previewed but never prefilled', () => {
  const markup = descriptionFields({
    ...ARTICLE,
    description: '',
    summary: '',
    descriptionSource: 'auto-body',
    effectiveDescription: '从正文自动提取的一段话。',
  });
  assert.match(/<input id="f-description"[^>]*>/.exec(markup)[0], /value=""/);
  assert.match(/<input id="f-summary"[^>]*>/.exec(markup)[0], /value=""/);
  assert.match(markup, /回退文本预览：从正文自动提取的一段话。/);
});

test('article-meta: an explicit description is not shown as a fallback preview', () => {
  const markup = descriptionFields({
    ...ARTICLE, description: '显式', descriptionSource: 'explicit-description', effectiveDescription: '显式',
  });
  assert.match(/<input id="f-description"[^>]*>/.exec(markup)[0], /value="显式"/);
  assert.doesNotMatch(markup, /回退文本预览/);
});

test('article-meta: protected articles get a fixed explanation instead of a fallback preview', () => {
  const markup = descriptionFields({
    ...ARTICLE,
    description: '显式但不生效',
    descriptionSource: 'protected',
    effectiveDescription: '该文章已加密，需访问网站输入密码查看。',
  });
  assert.match(markup, /该文章已加密/);
  assert.match(markup, /不会采用 description\/summary\/正文内容/);
  assert.doesNotMatch(markup, /回退文本预览/, '受保护文章的固定占位不是"回退预览"');
});

test('article-meta: an unknown descriptionSource degrades to the empty note without throwing', () => {
  const markup = descriptionFields({ ...ARTICLE, descriptionSource: 'some-future-source' });
  assert.match(markup, new RegExp(DESCRIPTION_SOURCE_TEXT.empty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('article-meta: source inference tracks the live inputs', () => {
  assert.equal(inferDescriptionSource({ description: 'x', summary: 'y' }), 'explicit-description');
  assert.equal(inferDescriptionSource({ description: '   ', summary: 'y' }), 'summary');
  assert.equal(inferDescriptionSource({ description: '', summary: '' }), 'auto-body');
  assert.equal(inferDescriptionSource({ description: 'x', isProtected: true }), 'protected');
});

test('article-meta: live hint updates in place and keeps the preview readable', () => {
  const element = { textContent: '' };
  refreshDescriptionHint(element, { description: '', summary: '', fallbackText: '自动提取的正文' });
  assert.match(element.textContent, /从公开正文自动提取/);
  assert.match(element.textContent, /回退文本预览：自动提取的正文/);

  refreshDescriptionHint(element, { description: '写了描述', summary: '', fallbackText: '自动提取的正文' });
  assert.match(element.textContent, /显式 description/);
  assert.doesNotMatch(element.textContent, /回退文本预览/);

  // null 元素不得抛错（面板切到别的 tab 时提示节点不存在）
  assert.doesNotThrow(() => refreshDescriptionHint(null, { description: 'x' }));
});

test('article-meta: HTML in a description is escaped in the panel', () => {
  const markup = descriptionFields({ ...ARTICLE, description: '"><img src=x onerror=alert(1)>' });
  assert.doesNotMatch(markup, /<img src=x onerror/);
  assert.match(markup, /&quot;&gt;&lt;img/);
});
