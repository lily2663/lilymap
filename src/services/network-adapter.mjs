function defaultHostAllowed(hostname, allowedHosts, allowHostname) {
  const host = String(hostname || '').toLowerCase();
  if (typeof allowHostname === 'function' && allowHostname(host)) return true;
  return (allowedHosts || []).some((item) => host === String(item).toLowerCase());
}

function networkError(message, code = 'NETWORK_ERROR') {
  return Object.assign(new Error(message), { code });
}

export function createNetworkAdapter({
  fetchImpl = globalThis.fetch,
  maxDefaultBytes = 8 * 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  function validateUrl(input, allowedHosts, allowHostname) {
    let url;
    try { url = new URL(input); }
    catch { throw networkError('远程地址格式无效。', 'INVALID_URL'); }
    if (url.protocol !== 'https:') throw networkError('仅允许 HTTPS 远程请求。', 'UNSAFE_PROTOCOL');
    if (!defaultHostAllowed(url.hostname, allowedHosts, allowHostname)) {
      throw networkError('远程地址不在允许列表中。', 'HOST_NOT_ALLOWED');
    }
    return url;
  }

  async function readLimited(response, limit = maxDefaultBytes) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > limit) {
      throw networkError('远程服务返回内容过大，已停止读取。', 'BODY_TOO_LARGE');
    }
    if (!response.body) return Buffer.alloc(0);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw networkError('远程服务返回内容过大，已停止读取。', 'BODY_TOO_LARGE');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }

  async function request(input, {
    allowedHosts = [],
    allowHostname,
    method = 'GET',
    headers = {},
    timeoutMs = 20_000,
    maxBytes = maxDefaultBytes,
    redirect = 'manual',
  } = {}) {
    const url = validateUrl(input, allowedHosts, allowHostname);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw networkError('远程请求超时，请检查网络后重试。', 'TIMEOUT');
      }
      throw networkError('无法连接远程服务，请检查网络后重试。', 'CONNECT_FAILED');
    }
    return response;
  }

  async function requestText(input, options = {}) {
    const response = await request(input, options);
    const bytes = await readLimited(response, options.maxBytes);
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      headers: response.headers,
      text: bytes.toString('utf8'),
      redirected: response.redirected,
      location: response.headers.get('location') || '',
    };
  }

  async function requestJson(input, options = {}) {
    const result = await requestText(input, options);
    let json;
    try { json = JSON.parse(result.text); }
    catch { throw networkError('远程服务返回了无法识别的数据。', 'INVALID_JSON'); }
    return { ...result, json };
  }

  async function requestMetadata(input, options = {}) {
    const response = await request(input, { ...options, method: options.method || 'HEAD', maxBytes: 0 });
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      headers: response.headers,
      redirected: response.redirected,
      location: response.headers.get('location') || '',
    };
  }

  return { requestText, requestJson, requestMetadata, validateUrl };
}
