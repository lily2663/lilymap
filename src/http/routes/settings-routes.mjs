// 这些路由自己持有状态码与错误码，因为设置保存是唯一需要区分
// 400 / 409 / 428 的写入路径；其余路由继续使用 fail(res, status, message)。
function statusOf(error, fallback) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : fallback;
}

function sendError(send, res, error, fallbackStatus, fallbackMessage) {
  const status = statusOf(error, fallbackStatus);
  send(res, status, {
    error: error?.message || fallbackMessage,
    code: typeof error?.code === 'string' ? error.code : (status === 400 ? 'INVALID_REQUEST' : status === 409 ? 'CONFLICT' : status === 428 ? 'VERSION_REQUIRED' : 'SAVE_FAILED'),
    ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
    ...(Array.isArray(error?.rollbackErrors) && error.rollbackErrors.length ? { rollbackErrors: error.rollbackErrors } : {}),
  });
}

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
        sendError(send, res, error, 400, '保存个人资料失败。');
      }
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/friends') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, await siteSettings.updateFriends(request));
      } catch (error) {
        sendError(send, res, error, 400, '保存友链失败。');
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
        sendError(send, res, error, 400, '保存博客设置失败。');
      }
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/settings') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8'));
        send(res, 200, await siteSettings.replaceSettingsRaw(request));
      } catch (error) {
        sendError(send, res, error, 400, '保存 hugo.toml 失败。');
      }
      return true;
    }
    return false;
  };
}
