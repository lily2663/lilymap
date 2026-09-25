export function createLayoutModuleRoutes({ readBody, send, fail, layoutModules }) {
  return async function handleLayoutModuleRoutes(req, res, url) {
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/modules') {
      try {
        const { modules, usage } = await layoutModules.moduleUsage();
        send(res, 200, {
          protocol: 'lily-module/v1',
          modules: Object.values(modules).sort((a, b) => a.name.localeCompare(b.name)),
          usage,
        });
      } catch (error) {
        fail(res, 500, error.message || '读取模块失败。');
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/modules/install') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 201, { ok: true, ...(await layoutModules.installSiteModule(request)) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '模块安装失败。');
      }
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/modules/config') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, { ok: true, ...(await layoutModules.configureModule(request)) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '保存模块失败。');
      }
      return true;
    }

    if (req.method === 'DELETE' && pathname === '/api/modules') {
      try {
        send(res, 200, { ok: true, ...(await layoutModules.uninstallSiteModule(String(url.searchParams.get('id') || ''))) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '模块卸载失败。');
      }
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/layouts') {
      try { send(res, 200, await layoutModules.loadLayoutEditor()); }
      catch (error) { fail(res, 500, error.message || '读取布局失败。'); }
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/layouts') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, { ok: true, ...(await layoutModules.saveLayout(request)) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '布局内容无效。');
      }
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/layouts/history') {
      try {
        send(res, 200, { history: await layoutModules.layoutHistory(String(url.searchParams.get('name') || '')) });
      } catch (error) {
        fail(res, 400, error.message || '读取布局历史失败。');
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/layouts/restore') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, { ok: true, ...(await layoutModules.restoreLayout(request)) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '恢复布局失败。');
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/layouts/reset') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, { ok: true, ...(await layoutModules.resetLayout(request)) });
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '恢复主题默认失败。');
      }
      return true;
    }

    return false;
  };
}
