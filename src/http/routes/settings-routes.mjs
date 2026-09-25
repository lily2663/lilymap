export function createSettingsRoutes({ readBody, send, fail, siteSettings }) {
  return async function handleSettingsRoutes(req, res, url) {
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/api/friends') {
      send(res, 200, await siteSettings.readFriends());
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/profile') {
      send(res, 200, await siteSettings.readProfile());
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/profile') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, await siteSettings.updateProfile(request));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '保存个人资料失败。');
      }
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/friends') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, await siteSettings.updateFriends(request));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '保存友链失败。');
      }
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/settings') {
      send(res, 200, await siteSettings.readSettings());
      return true;
    }
    if (req.method === 'PATCH' && pathname === '/api/settings') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, await siteSettings.patchSettings(request));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '保存博客设置失败。');
      }
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/settings') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, await siteSettings.replaceSettingsRaw(request));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '保存 hugo.toml 失败。');
      }
      return true;
    }
    return false;
  };
}
