import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontMatter, patchFrontMatter } from '../src/domain/front-matter.mjs';
import {
  EMPTY_SITE_SHARE_CONTEXT,
  PROTECTED_ALLOWED_SOURCES,
  SHARE_IMAGE_SOURCES,
  explicitShareImage,
  isUsableShareImage,
  resolveShareImage,
} from '../src/domain/share-image.mjs';
import {
  isUsableShareImageInput,
  refreshShareImageHint,
  shareImageField,
} from '../public/js/features/article-meta.js';

// C1-05 分享图片段的纯逻辑用例（无需启动 server）。
// 判定顺序必须与主题 themes/lily-epitaph/layouts/partials/seo/share-image.html 一致：
//   公开:   文章 shareImage → 文章 cover → 站点 params.shareImage → 头像
//   受保护: 站点 params.shareImage → 头像

const SITE = { siteShare: '/share/lily-house.png', avatar: '/assets/img/avatar.webp' };

test('C1-05 share-image: the fallback order is articleShare -> cover -> siteShare -> avatar', () => {
  assert.equal(
    resolveShareImage({ frontMatter: { shareImage: '/s/a.png', cover: '/c.png' }, site: SITE }).shareImageSource,
    SHARE_IMAGE_SOURCES.ARTICLE,
  );
  assert.equal(
    resolveShareImage({ frontMatter: { cover: '/c.png' }, site: SITE }).shareImageSource,
    SHARE_IMAGE_SOURCES.COVER,
  );
  assert.equal(
    resolveShareImage({ frontMatter: {}, site: SITE }).shareImageSource,
    SHARE_IMAGE_SOURCES.SITE,
  );
  assert.equal(
    resolveShareImage({ frontMatter: {}, site: { siteShare: '', avatar: '/a.png' } }).shareImageSource,
    SHARE_IMAGE_SOURCES.AVATAR,
  );
  assert.equal(
    resolveShareImage({ frontMatter: {}, site: EMPTY_SITE_SHARE_CONTEXT }).shareImageSource,
    SHARE_IMAGE_SOURCES.NONE,
  );
});

test('C1-05 share-image: the effective url always matches the reported source', () => {
  const cases = [
    [{ shareImage: '/s/a.png', cover: '/c.png' }, { siteShare: '/site.png', avatar: '/av.png' }, 'articleShare', '/s/a.png'],
    [{ cover: '/c.png' }, { siteShare: '/site.png', avatar: '/av.png' }, 'cover', '/c.png'],
    [{}, { siteShare: '/site.png', avatar: '/av.png' }, 'siteShare', '/site.png'],
    [{}, { siteShare: '', avatar: '/av.png' }, 'avatar', '/av.png'],
    [{}, { siteShare: '', avatar: '' }, 'none', ''],
  ];
  for (const [frontMatter, site, source, url] of cases) {
    const resolved = resolveShareImage({ frontMatter, site });
    assert.equal(resolved.shareImageSource, source);
    assert.equal(resolved.effectiveShareImage, url, `${source} 的生效地址必须与来源一致`);
  }
});

test('C1-05 share-image: an empty string counts as unset, exactly like Hugo with', () => {
  const resolved = resolveShareImage({
    frontMatter: { shareImage: '', cover: '' },
    site: { siteShare: '', avatar: '/av.png' },
  });
  assert.equal(resolved.shareImageSource, 'avatar');
  assert.equal(resolved.effectiveShareImage, '/av.png');
});

test('C1-05 share-image: a rejected value falls through to the next candidate like the theme does', () => {
  const resolved = resolveShareImage({
    frontMatter: { shareImage: 'javascript:alert(1)', cover: '/c.png' },
    site: SITE,
  });
  assert.equal(resolved.shareImageSource, 'cover', '非法值不能让整篇失去分享图');
  assert.equal(resolved.effectiveShareImage, '/c.png');
  assert.equal(resolved.rejected.length, 1);
  assert.match(resolved.rejected[0], /articleShare=.*javascript:alert\(1\)/);
});

test('C1-05 share-image: script schemes and disk paths never become the effective value', () => {
  const bad = [
    'javascript:alert(1)', 'JavaScript:alert(1)', ' file:///C:/secret.png',
    'data:image/png;base64,AAAA', 'vbscript:msgbox', 'C:\\Users\\lily\\pic.png',
    'D:/pics/x.png', 'relative/path.png', ' share/lily-house.png ',
  ];
  for (const value of bad) {
    assert.equal(isUsableShareImage(value), false, `${value} 必须被拒绝`);
    const resolved = resolveShareImage({ frontMatter: { shareImage: value }, site: EMPTY_SITE_SHARE_CONTEXT });
    assert.equal(resolved.effectiveShareImage, '', `${value} 不得成为生效值`);
    assert.equal(resolved.shareImageSource, 'none');
    assert.equal(resolved.rejected.length, 1, `${value} 必须被记录为 rejected`);
  }
});

test('C1-05 share-image: local absolute paths and http(s) urls are accepted', () => {
  for (const value of ['/share/lily-house.png', 'https://cdn.example.com/a.png', 'HTTP://EXAMPLE.COM/b.png']) {
    assert.equal(isUsableShareImage(value), true, `${value} 必须被接受`);
    assert.equal(resolveShareImage({ frontMatter: { shareImage: value }, site: SITE }).shareImageSource, 'articleShare');
  }
});

test('C1-05 share-image: protected articles never use an article-level shareImage or cover', () => {
  const protectedFrontMatter = { shareImage: '/secret/未审阅图.png', cover: '/secret/封面.png', params: { protected: true } };
  const resolved = resolveShareImage({ frontMatter: protectedFrontMatter, site: SITE });
  assert.equal(resolved.shareImageSource, 'siteShare', '受保护文章必须回退到站点默认图');
  assert.equal(resolved.effectiveShareImage, '/share/lily-house.png');
  assert.ok(PROTECTED_ALLOWED_SOURCES.includes(resolved.shareImageSource));
  assert.notEqual(resolved.shareImageSource, 'articleShare');
  assert.notEqual(resolved.shareImageSource, 'cover');

  const noSite = resolveShareImage({ frontMatter: protectedFrontMatter, site: { siteShare: '', avatar: '/av.png' } });
  assert.equal(noSite.shareImageSource, 'avatar');

  const nothing = resolveShareImage({ frontMatter: protectedFrontMatter, site: EMPTY_SITE_SHARE_CONTEXT });
  assert.equal(nothing.shareImageSource, 'none');
  assert.ok(PROTECTED_ALLOWED_SOURCES.includes(nothing.shareImageSource));
});

test('C1-05 share-image: protected detection uses Hugo truthiness and params wins over top level', () => {
  // params.protected 覆盖顶层（与 Hugo 的 front matter 合并规则一致）
  const paramsWins = resolveShareImage({
    frontMatter: { shareImage: '/a.png', protected: false, params: { protected: true } },
    site: SITE,
  });
  assert.equal(paramsWins.shareImageSource, 'siteShare');

  // 顶层 false 在 Hugo 里是假值，不是字符串
  const topFalse = resolveShareImage({ frontMatter: { shareImage: '/a.png', params: { protected: false } }, site: SITE });
  assert.equal(topFalse.shareImageSource, 'articleShare');

  // 字符串 "true" 在 Hugo 里是**真**
  const stringTrue = resolveShareImage({ frontMatter: { shareImage: '/a.png', params: { protected: 'true' } }, site: SITE });
  assert.equal(stringTrue.shareImageSource, 'siteShare', '字符串 "true" 必须按 Hugo 真值处理');
});

test('C1-05 share-image: Hugo truthiness, not JS Boolean, decides the candidates', () => {
  // "false" 在 Hugo 里是真值字符串，因此主题会采用它（再被协议白名单拒绝）
  const stringFalse = resolveShareImage({ frontMatter: { shareImage: 'false' }, site: SITE });
  assert.equal(stringFalse.shareImageSource, 'siteShare', '"false" 是真值 → 进入候选 → 被拒绝 → 回退');
  assert.equal(stringFalse.rejected.length, 1);

  // 数字 0 与 false 在 Hugo 里是假值
  assert.equal(resolveShareImage({ frontMatter: { shareImage: 0 }, site: SITE }).shareImageSource, 'siteShare');
  assert.equal(resolveShareImage({ frontMatter: { shareImage: false }, site: SITE }).shareImageSource, 'siteShare');
});

test('C1-05 share-image: only the posts section may use the article-level image', () => {
  const other = resolveShareImage({ frontMatter: { shareImage: '/a.png', cover: '/c.png' }, site: SITE, section: 'about' });
  assert.equal(other.shareImageSource, 'siteShare', '非 posts 页面与主题一致，不读取文章级候选');
});

test('C1-05 share-image: explicitShareImage returns the raw explicit value, never the fallback', () => {
  assert.equal(explicitShareImage({ shareImage: '/a.png' }), '/a.png');
  assert.equal(explicitShareImage({}), '', '未设置必须是空字符串，供编辑框回填');
  assert.equal(explicitShareImage({ shareImage: null }), '');
  assert.equal(explicitShareImage({ shareImage: '/a.png' }), '/a.png', '不能把 cover 混进来');
});

test('C1-05 share-image: the browser-side validator is byte-for-byte equivalent to the server one', () => {
  const samples = [
    '/a.png', 'https://x/y.png', 'HTTP://X/Y.PNG', 'javascript:alert(1)', ' javascript:alert(1)',
    'file:///c:/a.png', 'data:image/png;base64,AA', 'vbscript:x', 'C:\\a.png', 'relative.png',
    '', '   ', '//cdn.example.com/a.png', 'ftp://x/a.png',
  ];
  for (const sample of samples) {
    assert.equal(
      isUsableShareImageInput(sample), isUsableShareImage(sample),
      `${JSON.stringify(sample)} 在前后端必须给出相同判定`,
    );
  }
});

test('C1-05 share-image: the panel prefills only the explicit value, never the fallback', () => {
  const markup = shareImageField({
    shareImage: '',
    shareImageSource: 'siteShare',
    effectiveShareImage: '/share/lily-house.png',
  });
  const input = /<input id="f-shareImage"[^>]*>/.exec(markup)[0];
  assert.match(input, /value=""/, '回退值不能进输入框');
  assert.doesNotMatch(input, /disabled/, '公开文章的输入框必须可用');
  assert.match(markup, /留空则按“封面 → 站点默认图 → 头像”回退/);
  assert.match(markup, /当前生效：站点默认分享图（params\.shareImage）/);
  assert.match(markup, /生效图片：\/share\/lily-house\.png/);
  assert.match(markup, /id="share-image-source-hint"/);
});

test('C1-05 share-image: an explicit value is shown in the input and reported as articleShare', () => {
  const markup = shareImageField({
    shareImage: '/mine.png', shareImageSource: 'articleShare', effectiveShareImage: '/mine.png',
  });
  assert.match(/<input id="f-shareImage"[^>]*>/.exec(markup)[0], /value="\/mine.png"/);
  assert.match(markup, /本页专属分享图（shareImage）/);
});

test('C1-05 share-image: protected articles get a disabled input and an explicit warning', () => {
  const markup = shareImageField({
    shareImage: '/mine.png', protected: true, shareImageSource: 'siteShare', effectiveShareImage: '/share/lily-house.png',
  });
  assert.match(/<input id="f-shareImage"[^>]*>/.exec(markup)[0], /disabled/, '受保护文章必须禁用输入框');
  assert.match(markup, /受保护文章不使用专属分享图/);
  assert.match(markup, /当前生效：站点默认分享图/);
});

test('C1-05 share-image: an unknown source degrades to the none note without throwing', () => {
  const markup = shareImageField({ shareImage: '', shareImageSource: 'some-future-source' });
  assert.match(markup, /没有可用分享图/);
});

test('C1-05 share-image: HTML in the value is escaped in the panel', () => {
  const markup = shareImageField({ shareImage: '"><img src=x onerror=alert(1)>' });
  assert.doesNotMatch(markup, /<img src=x onerror/);
  assert.match(markup, /&quot;&gt;&lt;img/);
});

test('C1-05 share-image: the live hint never claims an invalid typed value will take effect', () => {
  const element = { textContent: '' };

  refreshShareImageHint(element, { shareImage: 'C:\\pics\\x.png' });
  assert.match(element.textContent, /不能作为分享图/);

  refreshShareImageHint(element, { shareImage: '/ok.png' });
  assert.match(element.textContent, /保存后生效/);

  refreshShareImageHint(element, { shareImage: '', cover: '/c.png' });
  assert.match(element.textContent, /回退到文章封面/);

  refreshShareImageHint(element, { shareImage: '', cover: '', savedSource: 'siteShare', savedEffective: '/site.png' });
  assert.match(element.textContent, /回退到站点默认分享图/);
  assert.match(element.textContent, /\/site\.png/);

  refreshShareImageHint(element, { shareImage: '', cover: '', savedSource: 'none' });
  assert.match(element.textContent, /“文章封面 → 站点默认图 → 头像”/);

  refreshShareImageHint(element, { shareImage: '/x.png', isProtected: true });
  assert.match(element.textContent, /受保护文章不使用专属分享图/);

  assert.doesNotThrow(() => refreshShareImageHint(null, { shareImage: 'x' }));
});

test('C1-05 front-matter: shareImage joins the line-level patch allowlist without reserializing', () => {
  const raw = [
    '---',
    'title: "标题"',
    'date: 2024-01-01',
    '# 这是一条注释，必须保留',
    'summary: "摘要"',
    'customUnknownKey: "必须保留"',
    'tags:',
    '  - "靶机"',
    'params:',
    '  protected: false',
    '---',
    '正文第一行',
  ].join('\n');

  const patched = patchFrontMatter(raw, { shareImage: '/share/new.png' });

  assert.match(patched, /^shareImage: "\/share\/new\.png"$/m, '必须写成一个顶层行');
  assert.match(patched, /# 这是一条注释，必须保留/, '注释不能被重序列化丢掉');
  assert.match(patched, /^customUnknownKey: "必须保留"$/m, '未知字段必须原样保留');
  assert.match(patched, /^summary: "摘要"$/m, '未提交的字段必须逐字不变');
  assert.match(patched, /^tags:\n {2}- "靶机"$/m, '列表块必须保持原样');
  assert.match(patched, /^params:\n {2}protected: false$/m, '嵌套表必须保持原样');
  assert.equal(patched.split('---')[2], raw.split('---')[2], '正文必须逐字不变');
});

test('C1-05 front-matter: patching shareImage replaces the existing line instead of appending a duplicate', () => {
  const raw = '---\ntitle: "t"\nshareImage: "/old.png"\n---\nbody\n';
  const patched = patchFrontMatter(raw, { shareImage: '/new.png' });
  assert.match(patched, /^shareImage: "\/new\.png"$/m);
  assert.equal(patched.match(/^shareImage:/gm).length, 1, '不能出现重复键');
  assert.doesNotMatch(patched, /\/old\.png/);
});

test('C1-05 front-matter: clearing shareImage writes an empty scalar that Hugo treats as unset', () => {
  const raw = '---\ntitle: "t"\nshareImage: "/old.png"\n---\nbody\n';
  const patched = patchFrontMatter(raw, { shareImage: '' });
  assert.match(patched, /^shareImage: ""$/m);

  // 清空后重新解析：显式值必须读回空字符串，回退链必须能继续往下走
  const { frontMatter } = parseFrontMatter(patched);
  assert.equal(explicitShareImage(frontMatter), '');
  assert.equal(
    resolveShareImage({ frontMatter, site: { siteShare: '/site.png', avatar: '' } }).shareImageSource,
    'siteShare',
    '清空后必须回退到站点默认图',
  );
});

test('C1-05 front-matter: a patched file round-trips through the parser with the same value', () => {
  const raw = '---\ntitle: "t"\ncover: "/c.png"\n---\nbody\n';
  const patched = patchFrontMatter(raw, { shareImage: '/share/x.png', cover: '/c.png' });
  const { frontMatter } = parseFrontMatter(patched);
  assert.equal(frontMatter.shareImage, '/share/x.png');
  assert.equal(frontMatter.cover, '/c.png');
  assert.equal(resolveShareImage({ frontMatter, site: SITE }).shareImageSource, 'articleShare');
});

test('C1-05 front-matter: an unrelated key patch does not introduce or touch shareImage', () => {
  const raw = '---\ntitle: "t"\nsummary: "s"\n---\nbody\n';
  const patched = patchFrontMatter(raw, { summary: '新摘要' });
  assert.doesNotMatch(patched, /shareImage/, '未提交 shareImage 时不得凭空写入该键');
});
