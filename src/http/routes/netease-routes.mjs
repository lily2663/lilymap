export function createNeteaseRoutes({ readBody, send, fail, netease }) {
  return async function handleNeteaseRoutes(req, res, url) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/music/netease/')) return false;

    try {
      if (req.method === 'POST' && pathname === '/api/music/netease/import') {
        const request = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8'));
        send(res, 201, { ok: true, ...(await netease.importPlaylist(request)) });
        return true;
      }
      if (req.method === 'GET' && pathname === '/api/music/netease/status') {
        send(res, 200, await netease.snapshotStatus(url.searchParams.get('id')));
        return true;
      }
      if (req.method === 'GET' && pathname === '/api/music/netease/list') {
        send(res, 200, await netease.listSnapshots());
        return true;
      }
      if (req.method === 'GET' && pathname === '/api/music/netease/tracks') {
        send(res, 200, await netease.snapshotTracks(url.searchParams.get('id')));
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/music/netease/check') {
        const request = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8'));
        send(res, 200, await netease.checkTrackAvailability(request));
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/music/netease/exclusions') {
        const request = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8'));
        send(res, 200, { ok: true, ...(await netease.saveExclusions(request)) });
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/music/netease/activate') {
        const request = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8'));
        send(res, 200, { ok: true, ...(await netease.activatePlaylist(request.playlistId)) });
        return true;
      }
    } catch (error) {
      const fallback = pathname.endsWith('/import') ? '网易云歌单导入失败。'
        : pathname.endsWith('/list') ? '读取网易云歌单列表失败。'
          : pathname.endsWith('/tracks') ? '读取歌单歌曲失败。'
            : pathname.endsWith('/check') ? '检测歌曲音源失败。'
              : pathname.endsWith('/exclusions') ? '保存歌单剔除设置失败。'
                : pathname.endsWith('/activate') ? '启用网易云歌单失败。'
                  : '读取网易云歌单状态失败。';
      fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || fallback);
      return true;
    }

    return false;
  };
}
