import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESCRIPTION_BUDGET,
  DESCRIPTION_SOURCES,
  PROTECTED_DESCRIPTION_TEXT,
  describeArticle,
  explicitDescription,
  explicitSummary,
  extractPublicBodyText,
  isProtectedFrontMatter,
  truncateCodepoints,
} from '../src/domain/article-description.mjs';

// L2-01 后端：description / summary / effectiveDescription / descriptionSource。
// 语义必须与主题 themes/lily-epitaph/layouts/partials/seo/description.html 一致：
//   受保护 → 固定占位；否则 description → summary → 正文提取(160 码点) → 空。
// 这里的每一条断言都已用真实 Hugo 0.165.0 + 本主题构建比对过（见 l2-acceptance.md）。

test('description: an explicit description wins over summary and body', () => {
  const result = describeArticle({
    frontMatter: { description: '显式 description', summary: '同时存在的 summary' },
    body: '正文内容不该被采用。',
  });
  assert.equal(result.effectiveDescription, '显式 description');
  assert.equal(result.descriptionSource, DESCRIPTION_SOURCES.EXPLICIT);
  assert.equal(result.budgeted, false);
});

test('description: explicit description is normalized but never truncated', () => {
  const long = '长'.repeat(400);
  const result = describeArticle({ frontMatter: { description: `  ${long}\n\n第二行 ` }, body: '' });
  assert.equal(result.descriptionSource, DESCRIPTION_SOURCES.EXPLICIT);
  assert.equal(result.effectiveDescription, `${long} 第二行`);
  assert.equal(result.budgeted, false, '显式 description 不做预算截断');
});

test('description: summary is used when description is absent or blank', () => {
  const missing = describeArticle({ frontMatter: { summary: '只有 summary' }, body: '正文' });
  assert.equal(missing.descriptionSource, DESCRIPTION_SOURCES.SUMMARY);
  assert.equal(missing.effectiveDescription, '只有 summary');

  const blank = describeArticle({ frontMatter: { description: '   ', summary: '只有 summary' }, body: '正文' });
  assert.equal(blank.descriptionSource, DESCRIPTION_SOURCES.SUMMARY, '全空白的 description 视为未设置');
});

test('description: falls back to public body text with a 160 codepoint budget', () => {
  const result = describeArticle({ frontMatter: {}, body: '公开正文的第一段，用来作为自动回退描述。' });
  assert.equal(result.descriptionSource, DESCRIPTION_SOURCES.AUTO_BODY);
  assert.equal(result.effectiveDescription, '公开正文的第一段，用来作为自动回退描述。');
  assert.equal(result.budgeted, false);
});

test('description: auto body never exceeds the budget including the ellipsis', () => {
  const result = describeArticle({ frontMatter: {}, body: 'A'.repeat(500) });
  assert.equal(result.descriptionSource, DESCRIPTION_SOURCES.AUTO_BODY);
  const length = Array.from(result.effectiveDescription).length;
  assert.equal(length, DESCRIPTION_BUDGET);
  assert.ok(result.effectiveDescription.endsWith('…'));
  assert.equal(result.budgeted, true);
});

test('description: auto body strips fenced code, tables and HTML blocks like the theme', () => {
  const body = [
    '# 标题会被内联文本保留',
    '',
    '第一段正文，描述这题的做法。',
    '',
    '```bash',
    'nmap -sV 10.0.0.1',
    '```',
    '',
    '| 列 A | 列 B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '<table><tr><td>HTML 表格也要移除</td></tr></table>',
    '',
    '第二段正文，提到提权成功。',
  ].join('\n');
  const text = extractPublicBodyText(body);
  assert.equal(text, '标题会被内联文本保留 第一段正文，描述这题的做法。 第二段正文，提到提权成功。');
  assert.doesNotMatch(text, /nmap/);
  assert.doesNotMatch(text, /HTML 表格/);
});

test('description: CRLF markdown still strips fenced code (regression)', () => {
  // 早期实现用单条正则匹配围栏，配合 m 标志时会在第一行末尾就结束匹配，
  // 把代码块首行当成正文；CRLF 又让 ``` 行带 \r 从而完全匹配失败。
  const body = '# SSRF\r\n\r\n```\r\ncd ~/Desktop/SSRF\r\ndocker-compose up -d\r\n```\r\n\r\nwindows环境：http://192.168.124.129:9091/\r\n';
  const text = extractPublicBodyText(body);
  assert.equal(text, 'SSRF windows环境：http://192.168.124.129:9091/');
});

test('description: an empty body with no explicit fields yields the empty source', () => {
  const result = describeArticle({ frontMatter: {}, body: '   \n\n  ' });
  assert.equal(result.effectiveDescription, '');
  assert.equal(result.descriptionSource, DESCRIPTION_SOURCES.EMPTY);
});

test('description: protected articles always use the fixed placeholder, even with explicit fields', () => {
  const result = describeArticle({
    frontMatter: { description: '不该采用的显式值', summary: '不该采用的摘要', params: { protected: true } },
    body: '加密正文不得参与描述计算。',
  });
  assert.equal(result.effectiveDescription, PROTECTED_DESCRIPTION_TEXT);
  assert.equal(result.descriptionSource, DESCRIPTION_SOURCES.PROTECTED);
  assert.equal(result.budgeted, false);
});

test('description: protected detection follows Hugo front matter merge semantics', () => {
  // 实测：顶层 protected 与 params.protected 同时存在时 params.protected 生效。
  assert.equal(isProtectedFrontMatter({ params: { protected: true } }), true);
  assert.equal(isProtectedFrontMatter({ protected: true }), true);
  assert.equal(isProtectedFrontMatter({ protected: true, params: { protected: false } }), false,
    '顶层 true + params false 时主题视为公开，旧 OR 逻辑会误判为受保护');
  assert.equal(isProtectedFrontMatter({ protected: false, params: { protected: true } }), true);
  // 字符串 "true" 在 Hugo 的 with 里是真值。
  assert.equal(isProtectedFrontMatter({ params: { protected: 'true' } }), true);
  assert.equal(isProtectedFrontMatter({ params: { protected: false } }), false);
  assert.equal(isProtectedFrontMatter({}), false);
  assert.equal(isProtectedFrontMatter(undefined), false);
});

test('description: explicit accessors never fall back to another field', () => {
  assert.equal(explicitDescription({ summary: '只有摘要' }), '');
  assert.equal(explicitDescription({ description: '显式' }), '显式');
  assert.equal(explicitDescription({}), '');
  assert.equal(explicitSummary({ description: '只有描述' }), '');
  assert.equal(explicitSummary({ summary: '摘要' }), '摘要');
  // 非字符串标量不应崩溃
  assert.equal(explicitDescription({ description: 42 }), '42');
  assert.equal(explicitSummary({ summary: null }), '');
});

test('description: truncation keeps grapheme clusters instead of splitting them', () => {
  const family = '👨‍👩‍👧';
  const text = `a${family}b${'中'.repeat(20)}`;
  const truncated = truncateCodepoints(text, 10);
  assert.ok(Array.from(truncated).length <= 10);
  assert.ok(truncated.endsWith('…'));
  assert.ok(truncated.includes(family), '完整字素簇必须保留，不能被切成残缺序列');
});

test('description: entities are decoded once and replacement chars dropped', () => {
  const text = extractPublicBodyText('引用 A&amp;B 与 <code>x</code>，损坏字符\uFFFD\uFFFD已移除。');
  assert.equal(text, '引用 A&B 与 x，损坏字符已移除。');
});

test('description: strong emphasis follows CommonMark flanking rules', () => {
  // 实测反例（真实文章 js-event-loop）：中文右括号后面的 ** 不能闭合，
  // Hugo 输出原样 `**事件循环（Event Loop）**`，这里必须一致。
  assert.equal(
    extractPublicBodyText('通过**事件循环（Event Loop）**让异步代码得以调度执行。'),
    '通过**事件循环（Event Loop）**让异步代码得以调度执行。',
  );
  // 空格夹住的 ** 不是强调，原样保留
  assert.equal(extractPublicBodyText('a ** b ** c'), 'a ** b ** c');
  // 合法的强调仍然剥掉星号
  assert.equal(extractPublicBodyText('正常**加粗**文字'), '正常加粗文字');
  // 行首/行尾的 ** 是合法分隔符
  assert.equal(extractPublicBodyText('**整行加粗**'), '整行加粗');
});

test('description: Python dunder names are never treated as emphasis', () => {
  // 真实语料里有大量 __name__ / __file__ / __main__，Hugo 不会把它们变成强调。
  assert.equal(extractPublicBodyText('把 __name__ 与 __file__ 换成 __main__ 即可。'), '把 __name__ 与 __file__ 换成 __main__ 即可。');
  assert.equal(extractPublicBodyText('if __name__ == "__main__":'), 'if __name__ == "__main__":');
});

test('description: NBSP and other Unicode spaces survive like the theme output', () => {
  // Hugo 的 replaceRE `\s+` 是 Go RE2 语义，不折叠 U+00A0；这里必须一致。
  const text = extractPublicBodyText('引号 &nbsp; 空格');
  assert.equal(text, '引号 \u00A0 空格');
  assert.notEqual(text, '引号 空格');
});
