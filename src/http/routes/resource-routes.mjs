export function createResourceRoutes({
  readBody,
  send,
  fail,
  resourceService,
  maxMediaBodyBytes,
}) {
  return async function handleResourceRoutes(req, res, url) {
    const { pathname } = url;

    if (req.method === 'POST' && pathname === '/api/asset/upload') {
      try {
        const bytes = await readBody(req, 24 * 1024 * 1024);
        const result = await resourceService.uploadAsset({
          name: url.searchParams.get('name') || '',
          area: url.searchParams.get('area') || 'static/assets/img',
          bytes,
        });
        send(res, 201, { ok: true, ...result });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '资源上传失败。');
      }
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/files') {
      send(res, 200, { files: await resourceService.listFiles() });
      return true;
    }

    if (['PUT', 'PATCH', 'DELETE'].includes(req.method) && pathname === '/api/file') {
      try {
        const body = req.method === 'PATCH'
          ? JSON.parse((await readBody(req, 4096)).toString('utf8'))
          : req.method === 'PUT'
            ? await readBody(req, maxMediaBodyBytes)
            : null;
        const result = await resourceService.mutateFile({
          method: req.method,
          relativePath: url.searchParams.get('path'),
          name: body?.name,
          bytes: Buffer.isBuffer(body) ? body : undefined,
        });
        send(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '资源操作失败。');
      }
      return true;
    }

    return false;
  };
}
