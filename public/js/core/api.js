import { $ } from './dom.js';

const activeOperations = new Map();
let operationSequence = 0;
let operationShowTimer = 0;
let operationHideTimer = 0;

function operationLabel(url, method = 'GET') {
  if (url.includes('/music/netease/import')) return '正在同步网易云歌单';
  if (url.includes('/music/netease/status')) return '正在检查歌单快照';
  if (url.includes('/media/')) return '正在处理媒体文件';
  if (url.includes('/upload')) return '正在上传文件';
  if (url.includes('/publish')) return '正在检查发布状态';
  if (method !== 'GET') return '正在保存更改';
  if (url.includes('/layouts')) return '正在加载页面布局';
  if (url.includes('/modules')) return '正在加载模块库';
  if (url.includes('/files')) return '正在扫描资源文件';
  return '正在加载数据';
}

function syncOperationProgress() {
  const box = $('#operation-progress');
  if (!activeOperations.size) return;
  box.hidden = false;
  box.classList.remove('is-complete');
  $('#operation-label').textContent = [...activeOperations.values()].at(-1);
  $('#operation-count').textContent = activeOperations.size > 1 ? `${activeOperations.size} 项任务` : '进行中';
}

export function beginOperation(label) {
  const id = ++operationSequence;
  clearTimeout(operationHideTimer);
  activeOperations.set(id, label);
  clearTimeout(operationShowTimer);
  operationShowTimer = setTimeout(syncOperationProgress, 120);
  return id;
}

export function endOperation(id) {
  if (id == null) return;
  activeOperations.delete(id);
  if (activeOperations.size) { syncOperationProgress(); return; }
  clearTimeout(operationShowTimer);
  const box = $('#operation-progress');
  if (box.hidden) return;
  box.classList.add('is-complete');
  $('#operation-count').textContent = '已完成';
  operationHideTimer = setTimeout(() => { if (!activeOperations.size) box.hidden = true; }, 500);
}

export function updateOperation(id, label) {
  if (activeOperations.has(id)) {
    activeOperations.set(id, label);
    syncOperationProgress();
  }
}

export async function trackedFetch(url, options = {}, label) {
  const operation = beginOperation(label || operationLabel(url, options.method || 'GET'));
  try { return await fetch(url, options); }
  finally { endOperation(operation); }
}

// 保留 status / code / details，同时保留 message：现有 UI 大量直接 toast(error.message)，
// 不能因为加结构化字段而改变它们的显示文本。network 为 true 表示请求没有拿到 HTTP 响应，
// 此时“是否已写入”无法确认，调用方必须先重新 GET 核对而不是直接重试。
export class ApiError extends Error {
  constructor(message, { status = 0, code = '', details = null, network = false, url = '', method = 'GET' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.network = network;
    this.url = url;
    this.method = method;
  }

  get isConflict() { return this.status === 409; }
  get isVersionRequired() { return this.status === 428; }
  get isValidation() { return this.status === 400; }
  get isUnconfirmed() { return this.network || this.status === 0; }
}

function fallbackMessage(status) {
  if (status === 428) return '保存被拒绝：页面版本信息缺失，请重新载入本页后再试。';
  if (status === 409) return '保存被拒绝：内容已在别处修改，请重新载入后比较差异。';
  if (status === 413) return '请求内容过大，未写入任何文件。';
  if (status === 423) return '该项目已有配置写任务正在进行，请稍后重试。';
  if (status >= 500) return '服务器处理失败，请查看 LilyMap 终端确认是否已提交。';
  return '请求失败';
}

export async function api(url, options = {}) {
  const { progressLabel, silentProgress, ...requestOptions } = options;
  const method = String(options.method || 'GET').toUpperCase();
  const operation = silentProgress ? null : beginOperation(progressLabel || operationLabel(url, options.method || 'GET'));
  try {
    let response;
    try {
      response = await fetch(url, {
        ...requestOptions,
        headers: {
          ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (cause) {
      throw new ApiError('与 LilyMap 的连接中断，无法确认本次请求是否已写入；请先重新载入核对再决定是否重试。', {
        status: 0, code: 'NETWORK_ERROR', network: true, url, method, details: { cause: String(cause?.message || cause) },
      });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(data?.error || fallbackMessage(response.status), {
        status: response.status,
        code: typeof data?.code === 'string' ? data.code : '',
        details: data?.details ?? (data?.rollbackErrors ? { rollbackErrors: data.rollbackErrors } : null),
        url,
        method,
      });
    }
    return data;
  } finally {
    endOperation(operation);
  }
}
