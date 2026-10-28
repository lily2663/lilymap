import { isObject } from './value.mjs';
import { isProtectedFrontMatter } from './article-description.mjs';

// 公开文章分享图的**唯一判定逻辑**（LilyMap 侧）。
// 必须与主题 themes/lily-epitaph/layouts/partials/seo/share-image.html 保持同一语义：
//   公开文章:  文章 shareImage → 文章 cover → 站点 params.shareImage → 头像
//   受保护文章: 站点 params.shareImage → 头像（**不**读取文章级 shareImage/cover）
//
// 与主题的三点差异（都是"LilyMap 只有磁盘文件、没有渲染上下文"导致的，不影响判定顺序）：
//   1) 主题用 `with $page.Params.shareImage`（Hugo 真值）判空，这里用同一套 hugoTruthy；
//   2) 主题只对 IsPage 且 Section == "posts" 的页面读取文章级候选；
//      LilyMap 的 articleRecord 只服务 content/ 下的 Markdown，因此由调用方传入 section；
//   3) 主题在非法值时**继续尝试下一个候选**（不是整体失败），这里逐字复刻同一行为，
//      并把被拒绝的值记进 rejected，方便 UI/测试解释"为什么生效的是下一级"。

export const SHARE_IMAGE_SOURCES = Object.freeze({
  ARTICLE: 'articleShare',
  COVER: 'cover',
  SITE: 'siteShare',
  AVATAR: 'avatar',
  NONE: 'none',
});

// 站点级上下文：属于站点配置，与单篇文章无关，由调用方读取一次后复用。
export const EMPTY_SITE_SHARE_CONTEXT = Object.freeze({ siteShare: '', avatar: '' });

// Hugo 的 `with` 真值语义：false / 0 / "" / 空集合 / nil 为假，其余为真。
// 不能直接用 JS 的 Boolean()：字符串 "false" 在 Hugo 里是**真**（同 article-description.mjs）。
function hugoTruthy(value) {
  if (value === false || value === 0 || value === '' || value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function asString(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * 显式 shareImage 原样返回（未设置 → 空字符串），供编辑框回填。
 * 与 explicitDescription 同一契约：**不做** fallback，也不做归一，
 * 否则前端无法区分"已保存的值"和"回退出来的值"。
 */
export function explicitShareImage(frontMatter) {
  return asString(frontMatter?.shareImage);
}

/**
 * 协议白名单，逐字对齐主题 share-image.html 第 51-54 行：
 *   拒绝 javascript: / file: / data: / vbscript:（大小写不敏感，前缀匹配）；
 *   接受 http:// 、https:// 前缀，或以 "/" 开头的站内绝对路径。
 * 注意主题写的是 `hasPrefix $raw "/"`（**区分大小写地**比较原值），
 * 因此 Windows 磁盘路径 `C:\...` 不会被当成站内路径，会被拒绝 —— 这是预期行为。
 */
export function isUsableShareImage(value) {
  const raw = asString(value).trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('file:')
    || lower.startsWith('data:') || lower.startsWith('vbscript:')) return false;
  const isRemote = lower.startsWith('http://') || lower.startsWith('https://');
  const isLocal = raw.startsWith('/');
  return isRemote || isLocal;
}

// 文章级候选只在"是 posts 分区的普通页面"时才参与（主题第 35 行）。
// section 由调用方给出；未给出时按 posts 处理 —— articleRecord 的调用方
// 已经用 content/ 根做了路径约束，posts 之外的内容不会被 PATCH 到这里。
function articleCandidatesAllowed({ frontMatter, section }) {
  if (isProtectedFrontMatter(frontMatter)) return false;
  const name = asString(section || 'posts').replace(/^\/+|\/+$/g, '');
  return name === 'posts';
}

/**
 * 计算公开分享图与来源。
 *
 * @param {object} input
 * @param {object} input.frontMatter 文章 front matter
 * @param {object} [input.site]      { siteShare, avatar } 站点级候选
 * @param {string} [input.section]   文章所属 section，默认 'posts'
 * @returns {{effectiveShareImage: string, shareImageSource: string, rejected: string[]}}
 */
export function resolveShareImage({ frontMatter, site, section } = {}) {
  const matter = isObject(frontMatter) ? frontMatter : {};
  const siteContext = isObject(site) ? site : EMPTY_SITE_SHARE_CONTEXT;

  const candidates = [];
  if (articleCandidatesAllowed({ frontMatter: matter, section })) {
    if (hugoTruthy(matter.shareImage)) {
      candidates.push({ value: matter.shareImage, source: SHARE_IMAGE_SOURCES.ARTICLE });
    }
    // 主题用 $page.Params.cover；LilyMap 的 articleRecord 把 cover 与 image 合并展示
    // （见 server.mjs 的 `cover: frontMatter.cover || frontMatter.image`）。
    // 分享图解析必须与主题一致，因此这里**只**认 cover，不把 image 混进来：
    // 否则 LilyMap 会宣称一个线上并不生效的来源。
    if (hugoTruthy(matter.cover)) {
      candidates.push({ value: matter.cover, source: SHARE_IMAGE_SOURCES.COVER });
    }
  }
  if (hugoTruthy(siteContext.siteShare)) {
    candidates.push({ value: siteContext.siteShare, source: SHARE_IMAGE_SOURCES.SITE });
  }
  if (hugoTruthy(siteContext.avatar)) {
    candidates.push({ value: siteContext.avatar, source: SHARE_IMAGE_SOURCES.AVATAR });
  }

  const rejected = [];
  for (const candidate of candidates) {
    const raw = asString(candidate.value).trim();
    if (!raw) continue;
    if (isUsableShareImage(raw)) {
      return { effectiveShareImage: raw, shareImageSource: candidate.source, rejected };
    }
    // 非法值只记录、不抛错：主题同样不会因为一个非法图片中断构建
    // （production 带 --panicOnWarning，用 warnf 会整站失败）。
    rejected.push(`${candidate.source}=${JSON.stringify(raw)}`);
  }
  return {
    effectiveShareImage: '',
    shareImageSource: SHARE_IMAGE_SOURCES.NONE,
    rejected,
  };
}

/**
 * 受保护文章的实际可能来源集合。供测试与 UI 断言"受保护时不会用文章图"。
 * 说明：这是**允许集合**，不是运行时结果。
 */
export const PROTECTED_ALLOWED_SOURCES = Object.freeze([
  SHARE_IMAGE_SOURCES.SITE,
  SHARE_IMAGE_SOURCES.AVATAR,
  SHARE_IMAGE_SOURCES.NONE,
]);
