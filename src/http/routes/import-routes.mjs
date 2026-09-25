export function createImportRoutes({ readBody, send, fail, importService }) {
  return async function handleImportRoutes(req, res, url) {
    const { pathname } = url;
    if (req.method === 'POST' && pathname === '/api/import/inspect') {
      try {
        const request = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
        send(res, 200, await importService.inspect(request));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '导入内容无效。');
      }
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/import') {
      try {
        const request = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
        send(res, 201, await importService.importRequest(request));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '导入失败。');
      }
      return true;
    }
    return false;
  };
}
