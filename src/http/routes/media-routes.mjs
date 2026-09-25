export function createMediaRoutes({
  readBody,
  send,
  fail,
  importWallpaperMedia,
  importUploadedVideo,
  maxMediaBodyBytes,
}) {
  return async function handleMediaRoutes(req, res, url) {
    const { pathname } = url;
    if (req.method === 'POST' && pathname === '/api/media/import') {
      try {
        const request = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
        send(res, 201, await importWallpaperMedia(String(request.sourcePath || ''), request.target));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '媒体导入失败。');
      }
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/media/upload') {
      const name = url.searchParams.get('name') || '';
      const targetName = String(url.searchParams.get('target') || '');
      try {
        const bytes = await readBody(req, maxMediaBodyBytes);
        send(res, 201, await importUploadedVideo({ name, bytes, targetName }));
      } catch (error) {
        fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 400, error.message || '视频上传失败。');
      }
      return true;
    }
    return false;
  };
}
