import { parse as parseTomlStrict } from 'smol-toml';

import { scalar } from './value.mjs';

// 本模块承担两部分职责，必须分开理解：
// 1) 验证：用维护中的完整 TOML 解析器（smol-toml，固定精确版本）做语法校验，
//    并给出可显示的行列信息；它不负责生成文本。
// 2) 保留式修改：在不重新序列化整个文件的前提下，只改目标赋值行的值片段，
//    或按原块定位后只改菜单块的 name/url/weight。未知表、嵌套数组、内联表、
//    多行字符串、CRLF/BOM 与行内注释都按原字节保留。
//    无法可靠定位的复杂语法不猜测，而是抛出带 code 的错误，由 UI 引导高级编辑。

const BOM = '\uFEFF';
const ARRAY_HEADER = /^\s*\[\[\s*([^[\]]+?)\s*\]\]\s*(?:#.*)?$/;
const TABLE_HEADER = /^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/;
const KEY_VALUE = /^(\s*)([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)(\s*)=(\s*)([\s\S]*)$/;

const CONTROL_ESCAPES = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
};

const MENU_KEYS = ['name', 'url', 'weight'];

export function domainError(status, message, code, details) {
  return Object.assign(new Error(message), { statusCode: status, code, details });
}

export function stripBom(raw) {
  const text = String(raw ?? '');
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function formatTomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map((item) => formatTomlValue(item)).join(', ')}]`;
  const text = String(value ?? '');
  return `"${text.replace(/[\\"\u0000-\u001f\u007f]/g, (character) => CONTROL_ESCAPES[character]
    || `\\u${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`)}"`;
}

function splitPath(text) {
  return String(text || '').split('.').map((part) => part.trim()).filter(Boolean);
}

// 扫描一段值文本，判断它是否在同一逻辑行内闭合。这是“能不能只替换值片段”的依据：
// 只有单行标量、单行数组、单行内联表允许替换；多行字符串/跨行数组一律拒绝。
function scanValueState(text) {
  let index = 0;
  let quote = '';
  let depth = 0;
  let commentAt = -1;
  while (index < text.length) {
    if (quote === '"""' || quote === "'''") {
      if (text.startsWith(quote, index)) { index += 3; quote = ''; continue; }
      if (quote === '"""' && text[index] === '\\') { index += 2; continue; }
      index += 1; continue;
    }
    if (quote === '"' || quote === "'") {
      if (quote === '"' && text[index] === '\\') { index += 2; continue; }
      if (text[index] === quote) { index += 1; quote = ''; continue; }
      index += 1; continue;
    }
    const character = text[index];
    if (character === '#') { commentAt = index; break; }
    if (text.startsWith('"""', index)) { quote = '"""'; index += 3; continue; }
    if (text.startsWith("'''", index)) { quote = "'''"; index += 3; continue; }
    if (character === '"' || character === "'") { quote = character; index += 1; continue; }
    if (character === '[' || character === '{') { depth += 1; index += 1; continue; }
    if (character === ']' || character === '}') { depth -= 1; index += 1; continue; }
    index += 1;
  }
  return { complete: quote === '' && depth <= 0, commentAt };
}

function newSection(fields) {
  return { kind: 'root', path: '', pathParts: [], headerLine: -1, startLine: 0, endLine: 0, arrayIndex: 0, container: -1, ...fields };
}

// 扫描整个文档结构。数组表（[[x]]）内部允许出现以它为路径前缀的嵌套表
// （例如 [[menus.main]] 里的 [menus.main.params]），这些嵌套表属于同一个块，
// 块结束位置由外层数组表决定。
function scanDocument(raw) {
  const text = String(raw ?? '');
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(1) : text;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const entries = [];
  const sections = [newSection({ startLine: 0 })];
  const arrayCounters = new Map();
  let current = 0;
  let openArray = -1;

  const close = (index) => {
    sections[current].endLine = index;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const arrayHeader = ARRAY_HEADER.exec(line);
    if (arrayHeader) {
      const pathParts = splitPath(arrayHeader[1]);
      const sectionPath = pathParts.join('.');
      close(index);
      if (openArray >= 0) {
        sections[openArray].endLine = index;
        openArray = -1;
      }
      const seen = (arrayCounters.get(sectionPath) || 0) + 1;
      arrayCounters.set(sectionPath, seen);
      sections.push(newSection({
        kind: 'array',
        path: sectionPath,
        pathParts,
        headerLine: index,
        startLine: index + 1,
        endLine: lines.length,
        arrayIndex: seen,
      }));
      current = sections.length - 1;
      openArray = current;
      continue;
    }
    const tableHeader = TABLE_HEADER.exec(line);
    if (tableHeader) {
      const pathParts = splitPath(tableHeader[1]);
      const sectionPath = pathParts.join('.');
      close(index);
      let container = -1;
      if (openArray >= 0) {
        const parent = sections[openArray].path;
        if (sectionPath.startsWith(`${parent}.`)) container = openArray;
        else {
          sections[openArray].endLine = index;
          openArray = -1;
        }
      }
      sections.push(newSection({
        kind: 'table',
        path: sectionPath,
        pathParts,
        headerLine: index,
        startLine: index + 1,
        endLine: lines.length,
        container,
      }));
      current = sections.length - 1;
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (!pair) continue;
    const section = sections[current];
    const keyParts = splitPath(pair[2]);
    if (!keyParts.length) continue;
    const valueStartCol = pair[1].length + pair[2].length + pair[3].length + 1 + pair[4].length;
    const firstSegment = line.slice(valueStartCol);
    const state = scanValueState(firstSegment);
    const pathParts = [...section.pathParts, ...keyParts];
    const entry = {
      kind: 'value',
      sectionIndex: current,
      lineIndex: index,
      endLine: index,
      pathParts,
      path: pathParts.join('.'),
      keyRaw: pair[2],
      valueStartCol,
      rawValue: firstSegment,
      gap: '',
      comment: '',
      multiline: false,
      indent: pair[1],
    };
    if (state.complete) {
      const cut = state.commentAt >= 0 ? state.commentAt : firstSegment.length;
      const segment = firstSegment.slice(0, cut);
      entry.rawValue = segment.trimEnd();
      entry.gap = segment.slice(entry.rawValue.length);
      entry.comment = firstSegment.slice(cut);
      entries.push(entry);
      continue;
    }
    entry.multiline = true;
    let cursor = index;
    let accumulated = firstSegment;
    let settled = state;
    while (!settled.complete && cursor + 1 < lines.length) {
      cursor += 1;
      accumulated += `\n${lines[cursor]}`;
      settled = scanValueState(accumulated);
    }
    entry.endLine = cursor;
    entry.rawValue = accumulated;
    entries.push(entry);
    index = cursor;
  }
  close(lines.length);
  if (openArray >= 0) sections[openArray].endLine = lines.length;
  sections[0].endLine = sections[0].endLine || lines.length;
  return { hasBom, newline, lines, sections, entries };
}

function joinLines(scan, lines) {
  return `${scan.hasBom ? BOM : ''}${lines.join(scan.newline)}`;
}

function entryValue(entry) {
  if (!entry || entry.multiline) return undefined;
  try {
    return parseTomlStrict(`value = ${entry.rawValue}`, { integersAsBigInt: 'asNeeded' }).value;
  } catch {
    return undefined;
  }
}

function sectionOf(scan, entry) {
  return scan.sections[entry.sectionIndex];
}

function entriesInSection(scan, index) {
  return scan.entries.filter((entry) => entry.sectionIndex === index);
}

function lastContentLine(scan, sectionIndex) {
  const section = scan.sections[sectionIndex];
  for (let index = section.endLine - 1; index >= section.startLine; index -= 1) {
    if (scan.lines[index].trim() !== '') return index + 1;
  }
  return section.startLine;
}

// Hugo 生态与本文档现有 hugo.toml 使用两空格缩进；新建块沿用该风格，
// 已存在块则沿用该块首个子项的缩进，避免同一文件出现两种缩进。
function indentStyleOf(scan, sectionIndex) {
  const local = entriesInSection(scan, sectionIndex).find((entry) => entry.indent);
  if (local) return local.indent;
  const any = scan.entries.find((entry) => entry.indent);
  return any ? any.indent : '  ';
}

function findSection(scan, pathParts, kind = 'table') {
  return scan.sections.find((section) => section.kind === kind && section.path === pathParts.join('.'));
}

function findInsertIndex(scan, sectionParts) {
  const head = sectionParts[0];
  let index = -1;
  for (const section of scan.sections) {
    if (section.pathParts[0] === head) index = Math.max(index, section.endLine);
  }
  const at = index < 0 ? scan.lines.length : index;
  const blankBefore = at > 0 && scan.lines[at - 1].trim() !== '';
  return { index: at, blankBefore };
}

function replaceEntryValue(scan, entry, value) {
  const lines = scan.lines.slice();
  lines[entry.lineIndex] = scan.lines[entry.lineIndex].slice(0, entry.valueStartCol)
    + formatTomlValue(value)
    + entry.gap
    + entry.comment;
  return joinLines(scan, lines);
}

function insertField(scan, pathParts, value) {
  const key = pathParts.at(-1);
  const sectionParts = pathParts.slice(0, -1);
  const target = sectionParts.length ? findSection(scan, sectionParts) : scan.sections[0];
  if (target) {
    const index = scan.sections.indexOf(target);
    const indent = sectionParts.length ? indentStyleOf(scan, index) : '';
    const lines = scan.lines.slice();
    lines.splice(lastContentLine(scan, index), 0, `${indent}${key} = ${formatTomlValue(value)}`);
    return joinLines(scan, lines);
  }
  const anchor = findInsertIndex(scan, sectionParts);
  const indent = indentStyleOf(scan, 0);
  const block = [];
  if (anchor.blankBefore) block.push('');
  block.push(`[${sectionParts.join('.')}]`);
  block.push(`${indent}${key} = ${formatTomlValue(value)}`);
  const lines = scan.lines.slice();
  lines.splice(anchor.index, 0, ...block);
  return joinLines(scan, lines);
}

function entryIndex(scan) {
  const byPath = new Map();
  for (const entry of scan.entries) byPath.set(entry.path, entry);
  return byPath;
}

function findAncestorBlocker(scan, pathParts) {
  const byPath = entryIndex(scan);
  for (let depth = 1; depth < pathParts.length; depth += 1) {
    const ancestor = pathParts.slice(0, depth).join('.');
    const entry = byPath.get(ancestor);
    if (entry) return { path: ancestor, reason: entry.multiline ? 'multiline' : 'inline-value' };
  }
  return null;
}

function arrayAncestorOf(scan, pathParts) {
  const joined = pathParts.join('.');
  return scan.sections
    .filter((section) => section.kind === 'array')
    .find((section) => joined.startsWith(`${section.path}.`));
}

/** 完整 TOML 语法校验；不抛异常，便于 GET 同时返回可编辑能力与诊断。 */
export function validateToml(raw) {
  try {
    return { ok: true, document: parseTomlStrict(stripBom(raw), { integersAsBigInt: 'asNeeded' }) };
  } catch (error) {
    return {
      ok: false,
      line: Number.isInteger(error?.line) ? error.line : 0,
      column: Number.isInteger(error?.column) ? error.column : 0,
      message: String(error?.message || 'TOML 语法无效。').split('\n')[0].trim(),
    };
  }
}

export function assertValidToml(raw, label = 'hugo.toml') {
  const result = validateToml(raw);
  if (result.ok) return result.document;
  throw domainError(
    400,
    `${label} TOML 语法无效（第 ${result.line} 行第 ${result.column} 列）：${result.message}`,
    'INVALID_TOML',
    { line: result.line, column: result.column },
  );
}

function normalizeScalar(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeScalar);
  return value;
}

function isPlainTable(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function flatten(node, prefix, output) {
  for (const [key, value] of Object.entries(node)) {
    if (!prefix && key === 'menus') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainTable(value)) flatten(value, path, output);
    else output[path] = normalizeScalar(value);
  }
}

// 旧版逐行提取器：只在完整解析失败时作为降级读取使用。
// server.mjs 读取单个开关（params.protected.managementEnabled）不能因为
// 文件正在被外部编辑器改写而抛错。它不参与任何写入路径。
function extractLegacy(raw) {
  const values = {};
  const menus = [];
  let section = '';
  for (const line of stripBom(raw).split(/\r?\n/)) {
    if (/^\s*\[\[menus\.main\]\]/.test(line)) {
      section = 'menus.main';
      menus.push({});
      continue;
    }
    const heading = line.match(/^\s*\[([^[\]]+)\]\s*(?:#.*)?$/);
    if (heading) { section = heading[1].trim(); continue; }
    const pair = line.match(/^\s*([\w-]+)\s*=\s*(.+?)\s*$/);
    if (!pair) continue;
    const value = scalar(pair[2]);
    if (section === 'menus.main') Object.assign(menus.at(-1), { [pair[1]]: value });
    else values[section ? `${section}.${pair[1]}` : pair[1]] = value;
  }
  for (const menu of menus) {
    if (!Object.hasOwn(menu, 'name')) menu.name = '';
    if (!Object.hasOwn(menu, 'url')) menu.url = '/';
    if (!Object.hasOwn(menu, 'weight')) menu.weight = 10;
  }
  return { values, menus };
}

export function menusProjection(menus) {
  return (Array.isArray(menus) ? menus : []).map((menu) => ({
    name: typeof menu?.name === 'string' ? menu.name : '',
    url: typeof menu?.url === 'string' ? menu.url : '/',
    weight: typeof menu?.weight === 'number' && Number.isFinite(menu.weight) ? menu.weight : Number(menu?.weight) || 0,
  }));
}

export function parseToml(raw) {
  const result = validateToml(raw);
  if (!result.ok) return extractLegacy(raw);
  const values = {};
  flatten(result.document, '', values);
  const menus = menusProjection(result.document?.menus?.main);
  return { values, menus };
}

/**
 * 逐字段的可编辑能力。复杂语法（多行值、内联表祖先、数组表内字段）不允许可视化编辑，
 * UI 必须禁用该输入并引导使用“高级配置”原文编辑。
 */
export function analyzeToml(raw, schema) {
  const scan = scanDocument(raw);
  const byPath = entryIndex(scan);
  const fields = {};
  for (const section of schema?.sections || []) {
    for (const field of section?.fields || []) {
      const pathParts = splitPath(field?.path);
      if (!pathParts.length) continue;
      const entry = byPath.get(field.path);
      if (entry?.multiline) {
        fields[field.path] = { editable: false, reason: 'multiline' };
        continue;
      }
      if (entry) {
        fields[field.path] = { editable: true, reason: 'replace' };
        continue;
      }
      const blocker = findAncestorBlocker(scan, pathParts);
      if (blocker) {
        fields[field.path] = { editable: false, reason: blocker.reason, blockedBy: blocker.path };
        continue;
      }
      const arrayAncestor = arrayAncestorOf(scan, pathParts);
      fields[field.path] = arrayAncestor
        ? { editable: false, reason: 'array-table', blockedBy: arrayAncestor.path }
        : { editable: true, reason: 'append' };
    }
  }
  return { fields, menus: analyzeMenus(scan) };
}

function analyzeMenus(scan) {
  const blocks = menuBlocks(scan);
  if (!blocks.length) {
    const plain = findSection(scan, ['menus', 'main']);
    return plain ? { editable: false, reason: 'table-not-array' } : { editable: true, reason: 'append' };
  }
  for (const block of blocks) {
    const parts = block.section.pathParts;
    const own = entriesInSection(scan, block.index).filter((entry) => entry.pathParts.length === parts.length + 1);
    if (own.some((entry) => entry.multiline && MENU_KEYS.includes(entry.pathParts.at(-1)))) {
      return { editable: false, reason: 'multiline', block: block.section.arrayIndex };
    }
    const coreAsTable = scan.sections.some((section) => section.kind === 'table'
      && section.pathParts.length === parts.length + 1
      && MENU_KEYS.includes(section.pathParts.at(-1))
      && section.pathParts.slice(0, parts.length).join('.') === parts.join('.'));
    if (coreAsTable) return { editable: false, reason: 'core-not-scalar', block: block.section.arrayIndex };
  }
  return { editable: true, reason: 'replace' };
}

// 一个菜单块 = 数组表头 + 归属它的行 + 以它为前缀的嵌套表。
function menuBlocks(scan) {
  const blocks = [];
  for (const [index, section] of scan.sections.entries()) {
    if (section.kind !== 'array' || section.path !== 'menus.main') continue;
    const nested = scan.sections.filter((other) => other.container === index);
    const endLine = Math.max(section.endLine, ...nested.map((other) => other.endLine));
    blocks.push({ index, section, endLine, nestedIndexes: nested.map((other) => scan.sections.indexOf(other)) });
  }
  return blocks;
}

function trimTrailingBlanks(lines) {
  const copy = lines.slice();
  while (copy.length && copy.at(-1).trim() === '') copy.pop();
  return copy;
}

/**
 * 只改目标字段的值片段；保留缩进、等号空格、行尾空白与行内注释。
 * 目标不可安全定位时抛出 400 + FIELD_NOT_EDITABLE，绝不退化为全文件重序列化。
 */
export function patchTomlValue(raw, fieldPath, value) {
  const pathParts = splitPath(fieldPath);
  if (!pathParts.length) throw domainError(400, `字段路径无效：${fieldPath}`, 'INVALID_FIELD', { field: fieldPath });
  const scan = scanDocument(raw);
  const entry = entryIndex(scan).get(pathParts.join('.'));
  if (entry) {
    if (entry.multiline) {
      throw domainError(400, `字段 ${fieldPath} 的值跨多行，请改用“高级配置”编辑原始 hugo.toml。`, 'FIELD_NOT_EDITABLE', { field: fieldPath, reason: 'multiline' });
    }
    const arrayAncestor = arrayAncestorOf(scan, pathParts);
    if (arrayAncestor) {
      throw domainError(400, `字段 ${fieldPath} 位于数组表 ${arrayAncestor.path} 内，请改用“高级配置”。`, 'FIELD_NOT_EDITABLE', { field: fieldPath, reason: 'array-table', blockedBy: arrayAncestor.path });
    }
    return replaceEntryValue(scan, entry, value);
  }
  const blocker = findAncestorBlocker(scan, pathParts);
  if (blocker) {
    throw domainError(
      400,
      `字段 ${fieldPath} 位于内联表或复杂值 ${blocker.path} 内，请改用“高级配置”编辑原始 hugo.toml。`,
      'FIELD_NOT_EDITABLE',
      { field: fieldPath, reason: blocker.reason, blockedBy: blocker.path },
    );
  }
  const arrayAncestor = arrayAncestorOf(scan, pathParts);
  if (arrayAncestor) {
    throw domainError(400, `字段 ${fieldPath} 位于数组表 ${arrayAncestor.path} 内，请改用“高级配置”。`, 'FIELD_NOT_EDITABLE', { field: fieldPath, reason: 'array-table', blockedBy: arrayAncestor.path });
  }
  return insertField(scan, pathParts, value);
}

function coreEntriesOf(scan, block) {
  const parts = block.section.pathParts;
  const own = entriesInSection(scan, block.index).filter((entry) => entry.pathParts.length === parts.length + 1);
  const map = {};
  for (const key of MENU_KEYS) map[key] = own.find((entry) => entry.pathParts.at(-1) === key);
  return map;
}

function menuCurrent(scan, block) {
  const core = coreEntriesOf(scan, block);
  return {
    core,
    current: {
      name: entryValue(core.name),
      url: entryValue(core.url),
      weight: entryValue(core.weight),
    },
  };
}

function rebuildMenuBlock(scan, block, core, target) {
  const lines = scan.lines.slice(block.section.headerLine, block.endLine);
  for (const key of MENU_KEYS) {
    const entry = core[key];
    if (!entry) continue;
    const relative = entry.lineIndex - block.section.headerLine;
    lines[relative] = scan.lines[entry.lineIndex].slice(0, entry.valueStartCol)
      + formatTomlValue(target[key])
      + entry.gap
      + entry.comment;
  }
  const indent = indentStyleOf(scan, block.index);
  for (const key of MENU_KEYS) {
    if (core[key]) continue;
    let at = lines.length;
    while (at > 1 && lines[at - 1].trim() === '') at -= 1;
    lines.splice(at, 0, `${indent}${key} = ${formatTomlValue(target[key])}`);
  }
  return trimTrailingBlanks(lines);
}

function newMenuBlock(scan, target) {
  const indent = indentStyleOf(scan, 0);
  return [
    '[[menus.main]]',
    ...MENU_KEYS.map((key) => `${indent}${key} = ${formatTomlValue(target[key])}`),
  ];
}

/**
 * 菜单保留式修改：按原块定位，只改 name/url/weight 的值片段；
 * identifier/parent/params/自定义键与注释原样保留；0 是有效 weight。
 * 未发生实际变化时返回原字节。
 */
export function patchMenus(raw, menus) {
  const wanted = menusProjection(menus);
  const scan = scanDocument(raw);
  const blocks = menuBlocks(scan);
  const analysis = analyzeMenus(scan);

  if (!blocks.length) {
    if (!wanted.length) return raw;
    const plain = findSection(scan, ['menus', 'main']);
    if (plain) {
      throw domainError(400, 'menus.main 当前不是数组表形式，请改用“高级配置”编辑原始 hugo.toml。', 'MENUS_NOT_EDITABLE', { reason: 'table-not-array' });
    }
    const lines = scan.lines.slice();
    const block = [];
    for (const target of wanted) {
      if (block.length) block.push('');
      block.push(...newMenuBlock(scan, target));
    }
    const needBlank = lines.length > 0 && lines.at(-1).trim() !== '';
    lines.push(...(needBlank ? ['', ...block] : block));
    return joinLines(scan, lines);
  }
  if (!analysis.editable) {
    throw domainError(400, 'menus.main 含无法安全定位的复杂语法，请改用“高级配置”编辑原始 hugo.toml。', 'MENUS_NOT_EDITABLE', { reason: analysis.reason });
  }

  const details = blocks.map((block) => ({ block, ...menuCurrent(scan, block) }));

  const unchanged = details.length === wanted.length
    && details.every((detail, index) => {
      const current = menusProjection([detail.current])[0];
      return current.name === wanted[index].name && current.url === wanted[index].url && current.weight === wanted[index].weight;
    });
  if (unchanged) return raw;

  const taken = new Set();
  const pick = (predicate) => {
    for (const [index, detail] of details.entries()) {
      if (taken.has(index) || !predicate(detail)) continue;
      taken.add(index);
      return detail;
    }
    return null;
  };

  const ordered = wanted.map((target) => {
    const matched = pick((detail) => detail.current.name === target.name && detail.current.url === target.url)
      || pick((detail) => detail.current.name === target.name)
      || pick((detail) => detail.current.url === target.url);
    return matched
      ? rebuildMenuBlock(scan, matched.block, matched.core, target)
      : newMenuBlock(scan, target);
  });

  const regionStart = blocks[0].section.headerLine;
  const regionEnd = Math.max(...blocks.map((block) => block.endLine));
  const region = [];
  for (const lines of ordered) {
    if (region.length) region.push('');
    region.push(...lines);
  }
  const output = [...scan.lines.slice(0, regionStart), ...region, ...scan.lines.slice(regionEnd)];
  return joinLines(scan, output);
}
