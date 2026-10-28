import { esc } from '../core/dom.js';
import { sameValue } from '../core/value.js';

// 文章属性面板的纯逻辑。
// 抽成独立模块的原因：
//   1) 双描述字段的来源判定与最小 diff 需要能被直接单测（不依赖整页 app.js）；
//   2) app.js 有架构行数上限（scripts/check-architecture.mjs 900 行）。
// 本模块不发请求、不直接写 DOM 结构以外的状态，调用方负责 PATCH 与版本冲突处理。

/** 打开面板时的不可变基线。只取**显式**值：缺省 = 空字符串，不是回退文本。 */
export function metaSnapshot(article = {}) {
  return {
    title: article.title ? String(article.title) : '',
    date: String(article.date || '').slice(0, 10),
    slug: article.slug ? String(article.slug) : '',
    tags: Array.isArray(article.tags) ? article.tags.map(String) : [],
    description: typeof article.description === 'string' ? article.description : '',
    summary: typeof article.summary === 'string' ? article.summary : '',
    cover: article.cover ? String(article.cover) : '',
    shareImage: typeof article.shareImage === 'string' ? article.shareImage : '',
    draft: article.draft === true,
  };
}

// 与 PATCH /api/article 的服务端白名单保持一致（server.mjs 的 allowed 数组）。
export const ARTICLE_META_KEYS = Object.freeze(['title', 'date', 'slug', 'summary', 'description', 'cover', 'shareImage', 'draft', 'tags']);

/**
 * 只返回与基线不同的键，并按真实类型比较（不 String() 化）。
 * 空字符串表示"用户清空了这个字段"，是显式值，必须能提交；
 * undefined 表示该字段不在本次输入集合内，跳过。
 */
export function collectMetaChanges(baseline, current) {
  const changes = {};
  for (const key of ARTICLE_META_KEYS) {
    const next = current?.[key];
    if (next === undefined) continue;
    if (!sameValue(baseline?.[key], next)) changes[key] = next;
  }
  return changes;
}

export const DESCRIPTION_SOURCE_TEXT = Object.freeze({
  'explicit-description': '当前使用：本页「搜索/分享简介」中的显式 description。',
  summary: '当前使用：卡片摘要（summary）。未设置显式 description 时，搜索结果与分享卡片会回退到它。',
  'auto-body': '当前使用：从公开正文自动提取的前 160 个字符。未设置 description 与 summary 时才会用到。',
  protected: '该文章已加密：公开页面一律显示固定提示，不会采用 description/summary/正文内容。',
  empty: '当前没有可用描述：正文为空，公开页面会回退到站点描述。',
});

/** 按"当前输入框内容"即时推断来源，用于保存前的实时提示（不落盘、不发请求）。 */
export function inferDescriptionSource({ description = '', summary = '', isProtected = false } = {}) {
  if (isProtected) return 'protected';
  if (String(description).trim()) return 'explicit-description';
  if (String(summary).trim()) return 'summary';
  return 'auto-body';
}

/**
 * 两个描述输入框 + 来源说明。
 * 关键约束：没有显式 description 时**不能**把回退值填进输入框，
 * 否则用户会以为该值已保存，保存时又把它写回文件（旧实现的真实缺陷）。
 */
export function descriptionFields(article = {}) {
  const explicitDescription = typeof article.description === 'string' ? article.description : '';
  const summary = typeof article.summary === 'string' ? article.summary : '';
  const source = DESCRIPTION_SOURCE_TEXT[article.descriptionSource] ? article.descriptionSource : 'empty';
  const effective = typeof article.effectiveDescription === 'string' ? article.effectiveDescription : '';
  const note = DESCRIPTION_SOURCE_TEXT[source];
  // 回退预览只对"从正文算出来"的情况有意义：
  //   explicit-description / summary —— 值已经在输入框里，再复述一遍是噪声；
  //   protected —— 固定占位不是回退，标成"预览"会让人以为能改。
  const showFallback = source === 'auto-body' && Boolean(effective);
  return '<label class="field full"><span>搜索/分享简介（description）</span>'
    + `<input id="f-description" maxlength="500" value="${esc(explicitDescription)}" placeholder="留空时按下方说明自动回退">`
    + '<small class="muted">用于搜索结果与社交分享卡片（meta description / og:description）。留空时依次回退到“卡片摘要 → 正文提取”；该值本身不会被截断。</small></label>'
    + '<label class="field full"><span>卡片摘要（summary）</span>'
    + `<input id="f-summary" maxlength="500" value="${esc(summary)}" placeholder="留空时从正文提取">`
    + '<small class="muted">用于首页与列表的文章卡片摘要。它不会覆盖上面的 description。</small></label>'
    + `<small class="muted" id="description-source-hint">${esc(note)}${showFallback ? `<br>回退文本预览：${esc(effective)}` : ''}</small>`
    // 分享图字段挂在同一个渲染入口：app.js 的属性面板模板只有一个插值点
    // （`${descriptionFields(p)}`），改模板属于本任务写入范围之外的 app.js 改动。
    + shareImageField(article);
}

/** 输入时就地更新来源提示，不必等保存或重新打开面板。 */
export function refreshDescriptionHint(element, { description, summary, isProtected = false, fallbackText = '' } = {}) {
  if (!element) return;
  const source = inferDescriptionSource({ description, summary, isProtected });
  const note = DESCRIPTION_SOURCE_TEXT[source] || '';
  // 只有 auto-body 需要复述回退文本：summary/显式值就在输入框里，
  // 受保护占位是固定提示而不是"可改的回退"。
  const showFallback = source === 'auto-body' && Boolean(fallbackText);
  element.textContent = showFallback ? `${note}\n回退文本预览：${fallbackText}` : note;
}

/* ============================================================
 * 分享图（shareImage）
 * 判定顺序必须与主题 themes/lily-epitaph/layouts/partials/seo/share-image.html 一致：
 *   公开文章:  文章 shareImage → 文章 cover → 站点 params.shareImage → 头像
 *   受保护文章: 站点 params.shareImage → 头像（不读取文章级 shareImage/cover）
 * 服务端（src/domain/share-image.mjs）是权威；这里的推断只用于输入时的即时提示。
 * ============================================================ */

export const SHARE_IMAGE_SOURCE_TEXT = Object.freeze({
  articleShare: '本页专属分享图（shareImage）',
  cover: '文章封面（cover）',
  siteShare: '站点默认分享图（params.shareImage）',
  avatar: '站点头像（params.avatar）',
  none: '没有可用分享图（4 个候选都为空）',
});

// 与 src/domain/share-image.mjs 的 isUsableShareImage 逐条对齐（浏览器端不能 import 服务端模块）。
// 该等价关系由 test/share-image.test.mjs 的双向对照用例守住。
export function isUsableShareImageInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('file:')
    || lower.startsWith('data:') || lower.startsWith('vbscript:')) return false;
  return lower.startsWith('http://') || lower.startsWith('https://') || raw.startsWith('/');
}

const SHARE_IMAGE_FALLBACK_ORDER = '“文章封面 → 站点默认图 → 头像”';

/**
 * 分享图输入框 + 生效来源提示。
 *
 * 三条硬约束（与 description 的缺陷同类）：
 *   1) 输入框只回填**显式** shareImage；回退出来的图**不**填进输入框，
 *      否则用户会以为那张图已保存，保存时又把它写成文章专属图。
 *   2) 生效来源单独一行只读展示，值来自服务端 article.shareImageSource。
 *   3) 受保护文章：输入框禁用 + 明确说明"不使用专属分享图"。
 */
export function shareImageField(article = {}) {
  const explicit = typeof article.shareImage === 'string' ? article.shareImage : '';
  const isProtected = article.protected === true;
  const source = SHARE_IMAGE_SOURCE_TEXT[article.shareImageSource] ? article.shareImageSource : 'none';
  const effective = typeof article.effectiveShareImage === 'string' ? article.effectiveShareImage : '';
  const disabled = isProtected ? ' disabled' : '';
  const note = describeShareImageState({ isProtected, source, effective, explicit });
  return '<label class="field full"><span>分享图（shareImage）</span>'
    + `<input id="f-shareImage" maxlength="500" value="${esc(explicit)}"${disabled} spellcheck="false"`
    + ' placeholder="留空则按“封面 → 站点默认图 → 头像”回退">'
    + `<small class="muted">用于社交分享卡片（og:image）与搜索结果配图。填本站路径（以 / 开头）或 http(s) 地址；留空则依次回退到 ${SHARE_IMAGE_FALLBACK_ORDER}。'
    + '不要填磁盘路径。</small></label>`
    + `<small class="muted" id="share-image-source-hint">${esc(note)}</small>`;
}

function describeShareImageState({ isProtected, source, effective, explicit }) {
  if (isProtected) {
    return '受保护文章不使用专属分享图：输入框已禁用，公开页面固定使用「站点默认图 → 头像」。'
      + (source === 'siteShare' || source === 'avatar'
        ? `\n当前生效：${SHARE_IMAGE_SOURCE_TEXT[source]}。`
        : '');
  }
  const label = SHARE_IMAGE_SOURCE_TEXT[source] || SHARE_IMAGE_SOURCE_TEXT.none;
  const head = source === 'none' ? label : `当前生效：${label}。`;
  // 有效图地址就贴出来，方便核对是否真的是自己想发的那张。
  const detail = effective ? `\n生效图片：${effective}` : '';
  const explicitIgnored = explicit.trim() && source !== 'articleShare'
    ? '\n注意：输入框里的值未生效（不是可用地址，或该篇的分享图解析未采用它），公开页面会继续回退。'
    : '';
  return head + detail + explicitIgnored;
}

/**
 * 输入时就地更新分享图提示（保存前，不落盘）。
 * 只有"当前输入"与"已保存状态"一致时才复述服务端结论，否则明确说"保存后生效"。
 */
export function refreshShareImageHint(element, {
  shareImage = '', cover = '', isProtected = false, savedSource = 'none', savedEffective = '',
} = {}) {
  if (!element) return;
  const typed = String(shareImage ?? '').trim();
  if (isProtected) {
    element.textContent = '受保护文章不使用专属分享图：公开页面固定使用「站点默认图 → 头像」。';
    return;
  }
  if (typed) {
    element.textContent = isUsableShareImageInput(typed)
      ? '保存后生效：公开页面将使用本页专属分享图（优先于封面与站点默认图）。'
      : '这个值不能作为分享图：需以 / 开头（本站路径）或 http(s):// 开头。公开页面会忽略它并继续回退。';
    return;
  }
  // 输入框为空：回退链里下一个真正会命中的候选。
  if (String(cover ?? '').trim() && isUsableShareImageInput(cover)) {
    element.textContent = `留空：公开页面将回退到文章封面（cover）。\n生效图片：${String(cover).trim()}`;
    return;
  }
  const saved = SHARE_IMAGE_SOURCE_TEXT[savedSource];
  if (savedSource === 'siteShare' || savedSource === 'avatar') {
    element.textContent = `留空：公开页面将回退到${saved}。`
      + (savedEffective ? `\n生效图片：${savedEffective}` : '');
    return;
  }
  element.textContent = `留空：公开页面将回退到 ${SHARE_IMAGE_FALLBACK_ORDER}。`;
}
