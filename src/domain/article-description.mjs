import { isObject } from './value.mjs';

// 公开文章描述的**唯一判定逻辑**（LilyMap 侧）。
// 必须与主题 themes/lily-epitaph/layouts/partials/seo/description.html 保持同一语义：
//   1. 受保护文章 → 固定占位（不读取 description / summary / 正文）
//   2. 非空显式 description（不截断）
//   3. 非空显式 summary（不截断）
//   4. 公开正文自动提取（160 码点预算）
//   5. 空
//
// 与主题的唯一差异：主题从 *渲染后的 HTML* 提取（$page.Content），
// LilyMap 只有磁盘上的 Markdown 原文，因此 auto-body 走 Markdown 感知的去噪。
// 因此“来源判定/优先级”是权威且与主题一致；“auto-body 的具体文本”
// 是尽量逼近的等价实现（见 stage-lilymap/l2-changes.md 的已知差异）。

export const DESCRIPTION_BUDGET = 160;
export const PROTECTED_DESCRIPTION_TEXT = '该文章已加密，需访问网站输入密码查看。';

export const DESCRIPTION_SOURCES = Object.freeze({
  EXPLICIT: 'explicit-description',
  SUMMARY: 'summary',
  AUTO_BODY: 'auto-body',
  PROTECTED: 'protected',
  EMPTY: 'empty',
});

// Hugo 的 `with` 真值语义：false / 0 / "" / 空集合 / nil 为假，其余为真。
// 不能用 JS 的 `Boolean()` 直接判断：字符串 "false" 在 Hugo 里是**真**。
function hugoTruthy(value) {
  if (value === false || value === 0 || value === '' || value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 受保护判定，与 Hugo 的 front matter 合并规则一致。
 *
 * 实测（Hugo 0.165.0 + 本主题）：
 *   顶层 protected 与 params.protected 同时存在时，**params.protected 生效**；
 *   字符串 "true" 按真值处理。
 * 旧实现用 `params.protected === true || protected === true` 的 OR，
 * 在「顶层 true + params false」时会把公开文章误判为受保护，与主题输出相反。
 */
export function isProtectedFrontMatter(frontMatter) {
  const params = isObject(frontMatter?.params) ? frontMatter.params : {};
  if (Object.hasOwn(params, 'protected')) return hugoTruthy(params.protected);
  if (Object.hasOwn(frontMatter || {}, 'protected')) return hugoTruthy(frontMatter.protected);
  return false;
}

/** 显式值原样返回（未设置 → 空字符串），供编辑框回填，不做归一也不做 fallback。 */
export function explicitDescription(frontMatter) {
  const value = frontMatter?.description;
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

export function explicitSummary(frontMatter) {
  const value = frontMatter?.summary;
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function normalizeWhitespace(text) {
  // 注意：这里用 ASCII_WHITESPACE 而不是 \s，以保持与主题（Go RE2 \s）一致。
  return String(text ?? '').replace(ASCII_WHITESPACE, ' ').trim();
}

// 只清除替换字符本身；不猜“孤立 Latin-1 乱码片段”，避免把合法正文删掉。
function stripReplacementChars(text) {
  return normalizeWhitespace(String(text ?? '').replace(/\uFFFD+/g, ''));
}

const ENTITIES = {
  // &nbsp; 必须解成真 NBSP：Hugo 的 htmlUnescape 给的是 U+00A0，不是普通空格。
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', '#39': "'",
};

// Go RE2 的 \s 只覆盖 ASCII 空白，Hugo 的 replaceRE `\s+` 因此**不会**折叠
// U+00A0(NBSP)/U+3000 等 Unicode 空白 —— 实测 &nbsp; 在主题输出里被保留成 U+00A0。
// JS 的 \s 包含这些字符，直接用会把描述文本和主题产生空格差异，所以这里手写 ASCII 集合。
const ASCII_WHITESPACE = /[\t\n\v\f\r ]+/g;

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (whole, body) => {
    const named = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    if (named != null) return named;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

// 与主题 seo/text-budget.html 的 strip=block 对齐：整块移除这些节点。
const BLOCK_TAGS = ['pre', 'script', 'style', 'table', 'iframe', 'form', 'svg', 'noscript', 'figure', 'video', 'audio', 'select', 'textarea'];

function stripHtmlBlocks(text) {
  let output = text;
  for (const tag of BLOCK_TAGS) {
    output = output.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
    output = output.replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), ' ');
  }
  // 未闭合的残留开标签：把其后整段视为噪声（Markdown 里最常见的是裸 <pre>）。
  output = output.replace(/<(pre|script|style|table|iframe|form|svg|noscript|figure|video|audio|select|textarea)\b[^>]*>[\s\S]*$/gi, ' ');
  output = output.replace(/<\/(?:p|div|h[1-6]|li|tr|td|th|blockquote|section|article|header|footer)\s*>/gi, ' ');
  output = output.replace(/<br\s*\/?>/gi, ' ');
  output = output.replace(/<[^>]+>/g, '');
  return output;
}

// 围栏代码块必须按行扫描：用正则 `[\s\S]*?$` 配合 m 标志会让惰性匹配在第一行
// 末尾就满足，导致开围栏后的第一行被当成正文（已实测的 bug）。
function stripFencedCode(text) {
  const lines = String(text).split('\n');
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && open[2].trim() === '') {
        fence = null;
      }
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function stripIndentedCode(text) {
  const lines = text.split('\n');
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    const isIndented = /^(?: {4}|\t)/.test(line);
    if (isIndented) { dropping = true; continue; }
    if (dropping && line.trim() === '') continue;
    dropping = false;
    kept.push(line);
  }
  return kept.join('\n');
}

function stripTables(text) {
  const lines = text.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] ?? '';
    const isDelimiter = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next) && next.includes('-') && next.includes('|');
    if (line.includes('|') && isDelimiter) {
      // 表头 + 分隔行 + 连续表格行整块丢弃（对齐主题的 table 整块移除）。
      index += 1;
      while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim() !== '') index += 1;
      kept.push(' ');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// CommonMark 的分隔符"侧翼"规则：`**text**` 只有两侧都构成合法分隔符时才是强调。
// 实测反例（真实文章 js-event-loop）：
//   `通过**事件循环（Event Loop）**让异步...`
//   闭合的 `**` 前面是中文右括号（标点）、后面是非标点，因此**不能闭合**，
//   Hugo 输出的是原样的 `**事件循环（Event Loop）**`。
// 用朴素正则剥掉星号会让 LilyMap 的预览与线上文本不一致。
// 说明：下划线强调一律不处理 —— 真实语料里 `__name__` / `__file__` 是 Python
// 特殊变量名，Hugo（CommonMark 的词内下划线规则）不会把它们变成强调。
const PUNCTUATION = /[\p{P}\p{S}]/u;

function isWhitespace(char) {
  return char === undefined || char === '' || /\s/u.test(char);
}

function isPunctuation(char) {
  return char !== undefined && char !== '' && PUNCTUATION.test(char);
}

function isLeftFlanking(text, start, end) {
  const after = text[end];
  const before = text[start - 1];
  if (isWhitespace(after)) return false;
  return !isPunctuation(after) || isWhitespace(before) || isPunctuation(before);
}

function isRightFlanking(text, start, end) {
  const before = text[start - 1];
  const after = text[end];
  if (isWhitespace(before)) return false;
  return !isPunctuation(before) || isWhitespace(after) || isPunctuation(after);
}

// 只处理 `**strong**`（单行、内部无星号）。找不到合法闭合时原样保留。
function stripStrongEmphasis(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('**', index);
    if (open < 0) { output += text.slice(index); break; }
    output += text.slice(index, open);
    const openEnd = open + 2;
    if (!isLeftFlanking(text, open, openEnd)) { output += '**'; index = openEnd; continue; }
    let close = text.indexOf('**', openEnd);
    let closed = -1;
    while (close >= 0) {
      if (isRightFlanking(text, close, close + 2) && !text.slice(openEnd, close).includes('\n')) {
        closed = close;
        break;
      }
      close = text.indexOf('**', close + 2);
    }
    if (closed < 0) { output += '**'; index = openEnd; continue; }
    output += text.slice(openEnd, closed);
    index = closed + 2;
  }
  return output;
}

function stripInlineMarkup(text) {
  const stripped = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')            // 图片整体丢弃
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')           // 链接保留文字
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[\^[^\]]*\]/g, ' ')                     // 脚注引用
    .replace(/`+([^`]*)`+/g, '$1')                     // 行内代码保留文字（同主题）
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')          // 标题
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')               // 引用
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, '') // 列表标记
    .replace(/^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, ' '); // 分隔线
  return stripStrongEmphasis(stripped).replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
}

/**
 * 从 Markdown 原文提取公开正文摘要（对齐主题的 block 去噪 + 160 码点预算）。
 * 公开调用以便单元测试与复用；不要在保存路径上依赖它做校验。
 */
export function extractPublicBodyText(body) {
  // 必须先把 CRLF / 单独 CR 归一成 \n：逐行扫描的围栏与缩进代码判定都依赖
  // 行尾精确匹配，残留的 \r 会让 ``` 行看起来“不干净”从而漏掉整块围栏。
  let text = String(body ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  text = stripFencedCode(text);
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = stripIndentedCode(text);
  text = stripHtmlBlocks(text);       // 先按 HTML 结构去噪（原文里的裸 HTML）
  text = stripTables(text);           // Markdown 表格整块移除
  text = stripInlineMarkup(text);
  text = decodeEntities(text);
  return stripReplacementChars(text);
}

const EXTEND_CHAR = /^[\u200D\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}\u0300-\u036F\u20D0-\u20F0\u1AB0-\u1AFF\u1DC0-\u1DFF\uFE20-\uFE2F]$/u;

/**
 * 按 Unicode 码点预算截断，并为单个省略号预留 1 码点。
 * 回退到安全字素簇边界，避免把 👨‍👩‍👧 之类切成残缺序列（同主题 text-budget.html）。
 */
export function truncateCodepoints(text, budget = DESCRIPTION_BUDGET) {
  const normalized = normalizeWhitespace(text);
  const runes = Array.from(normalized);
  if (runes.length <= budget) return normalized;
  const limit = Math.max(budget - 1, 0);
  let safe = limit;
  for (let step = 0; step < 12 && safe > 0; step += 1) {
    const current = runes[safe] ?? '';
    const previous = runes[safe - 1] ?? '';
    if (EXTEND_CHAR.test(current) || previous === '\u200D') safe -= 1;
    else break;
  }
  const head = normalizeWhitespace(runes.slice(0, safe).join(''));
  return head ? `${head}…` : '…';
}

/**
 * 计算文章的公开描述与来源。
 * @returns {{effectiveDescription: string, descriptionSource: string, budgeted: boolean}}
 */
export function describeArticle({ frontMatter, body } = {}) {
  const matter = frontMatter || {};
  if (isProtectedFrontMatter(matter)) {
    return {
      effectiveDescription: PROTECTED_DESCRIPTION_TEXT,
      descriptionSource: DESCRIPTION_SOURCES.PROTECTED,
      budgeted: false,
    };
  }

  const description = normalizeWhitespace(explicitDescription(matter));
  if (description) {
    return {
      effectiveDescription: description,
      descriptionSource: DESCRIPTION_SOURCES.EXPLICIT,
      budgeted: false,
    };
  }

  const summary = normalizeWhitespace(explicitSummary(matter));
  if (summary) {
    return {
      effectiveDescription: summary,
      descriptionSource: DESCRIPTION_SOURCES.SUMMARY,
      budgeted: false,
    };
  }

  const automatic = truncateCodepoints(extractPublicBodyText(body), DESCRIPTION_BUDGET);
  if (automatic) {
    return {
      effectiveDescription: automatic,
      descriptionSource: DESCRIPTION_SOURCES.AUTO_BODY,
      budgeted: Array.from(normalizeWhitespace(extractPublicBodyText(body))).length > DESCRIPTION_BUDGET,
    };
  }

  return {
    effectiveDescription: '',
    descriptionSource: DESCRIPTION_SOURCES.EMPTY,
    budgeted: false,
  };
}
