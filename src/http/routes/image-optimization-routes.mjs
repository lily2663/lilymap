export function createImageOptimizationRoutes({ readBody, send, fail, imageOptimization }) {
  return async function handleImageOptimizationRoutes(req, res, url) {
    if (url.pathname !== '/api/images/optimization' || !['GET', 'POST'].includes(req.method)) return false;
    try {
      if (req.method === 'GET') send(res, 200, await imageOptimization.snapshot());
      else {
        const bytes = await readBody(req, 4096);
        const request = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
        if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length || url.search) {
          throw Object.assign(new Error('图片优化不接受命令、路径或其他参数。'), { statusCode: 400 });
        }
        send(res, 202, { ok: true, ...(await imageOptimization.start()) });
      }
    } catch (error) {
      fail(res, Number.isInteger(error.statusCode) ? error.statusCode : req.method === 'GET' ? 500 : 400,
        error.message || '图片优化失败。');
    }
    return true;
  };
}
