import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveInside } from '../fs/path-security.mjs';
import { createProcessRunner } from './process-runner.mjs';

export function mediaKind(target, uploadImageExtensions, uploadVideoExtensions) {
  const extension = path.extname(String(target || '')).toLowerCase();
  if (uploadImageExtensions.has(extension)) return 'image';
  if (uploadVideoExtensions.has(extension)) return 'video';
  return 'other';
}

export function createMediaService({
  repoRoot,
  siteAssetsRoot,
  hugoPublicRoot,
  uploadImageExtensions,
  uploadVideoExtensions,
  mediaTargetNames,
  hasExpectedImageSignature,
  httpError,
  atomicCreate,
  scheduleBuild,
  ffmpegCommand = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobeCommand = process.env.FFPROBE_PATH || 'ffprobe',
  processRunner,
  fsApi = fs,
}) {
  const runner = processRunner || createProcessRunner({
    defaultTimeoutMs: 180_000,
    defaultMaxOutputBytes: 256 * 1024,
  });
  let toolsPromise;

  const exists = async (target) => {
    try { await fsApi.access(target); return true; } catch { return false; }
  };
  const relativeToRepo = (target) => path.relative(repoRoot, target).split(path.sep).join('/');
  const inside = (root, candidate) => resolveInside(root, candidate);
  const publicPathForRepoFile = (target) => {
    const resolved = path.resolve(target);
    const staticRoot = path.join(repoRoot, 'static');
    if (resolved === staticRoot || resolved.startsWith(`${staticRoot}${path.sep}`)) {
      const relative = path.relative(staticRoot, resolved).split(path.sep).join('/');
      return relative ? `/${relative}` : '/';
    }
    return null;
  };

  async function mediaToolsStatus() {
    if (!toolsPromise) {
      toolsPromise = Promise.all([
        runner.run(ffmpegCommand, ['-version'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }),
        runner.run(ffprobeCommand, ['-version'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }),
      ]).then(([ffmpeg, ffprobe]) => ({
        available: ffmpeg.code === 0 && ffprobe.code === 0,
        ffmpeg: ffmpeg.code === 0,
        ffprobe: ffprobe.code === 0,
        version: (ffmpeg.stdout.match(/^ffmpeg version\s+([^\s]+)/m)?.[1] || '').slice(0, 80),
      }));
    }
    return toolsPromise;
  }

  async function inspectMedia(source) {
    const result = await runner.run(ffprobeCommand, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,avg_frame_rate:format=duration,size,format_name',
      '-of', 'json', source,
    ], { cwd: repoRoot, timeoutMs: 20_000, maxOutputBytes: 128 * 1024 });
    if (result.code !== 0) {
      const message = result.timedOut ? '媒体探测超时。' : '无法读取媒体文件：文件可能损坏，或不是受支持的视频格式。';
      throw httpError(400, message);
    }
    try {
      const parsed = JSON.parse(result.stdout);
      const stream = parsed.streams?.[0];
      if (!stream?.width || !stream?.height) throw new Error('missing video stream');
      return {
        codec: stream.codec_name || '',
        width: Number(stream.width) || 0,
        height: Number(stream.height) || 0,
        frameRate: stream.avg_frame_rate || '',
        duration: Number(parsed.format?.duration) || 0,
        size: Number(parsed.format?.size) || 0,
        format: parsed.format?.format_name || '',
      };
    } catch {
      throw httpError(400, '媒体探测结果无效，无法安全导入。');
    }
  }

  async function syncStaticPreview(sourcePath) {
    const publicPath = publicPathForRepoFile(sourcePath);
    if (!publicPath) return { previewSynced: false, warning: '资源不在 static 目录，无法生成公开路径。' };
    const destination = inside(hugoPublicRoot, publicPath.slice(1).split('/').join(path.sep));
    if (!destination) return { previewSynced: false, warning: '预览目标路径不安全。' };
    try {
      await fsApi.mkdir(path.dirname(destination), { recursive: true });
      await fsApi.copyFile(sourcePath, destination);
      return { previewSynced: true, warning: '' };
    } catch (error) {
      scheduleBuild();
      return { previewSynced: false, warning: error.message || '本地预览同步失败，已安排 Hugo 重建。' };
    }
  }

  async function importWallpaperMedia(sourcePath, targetName) {
    const targetPrefix = mediaTargetNames.get(String(targetName || ''));
    if (!targetPrefix) throw httpError(400, '壁纸目标只能是日间或夜间。');
    if (!path.isAbsolute(sourcePath)) throw httpError(400, '请输入完整的本机绝对路径。');
    const source = path.resolve(sourcePath);

    let stat;
    try { stat = await fsApi.stat(source); }
    catch { throw httpError(404, '没有找到这个本机文件，请检查盘符和路径。'); }
    if (!stat.isFile()) throw httpError(400, '该路径不是文件。');
    if (stat.size > 1024 * 1024 * 1024) throw httpError(413, '媒体文件超过 1 GB，不适合作为网页壁纸。');

    const extension = path.extname(source).toLowerCase();
    const kind = mediaKind(source, uploadImageExtensions, uploadVideoExtensions);
    if (!['image', 'video'].includes(kind)) throw httpError(400, '支持 PNG、JPG、WebP、GIF、AVIF、MP4、WebM、MOV、M4V、MKV、AVI。');
    if (kind === 'image' && stat.size > 64 * 1024 * 1024) throw httpError(413, '图片文件超过 64 MB，已拒绝整文件载入；请先压缩后再导入。');

    const directory = path.join(siteAssetsRoot, kind === 'video' ? 'media' : 'img', 'wallpapers');
    await fsApi.mkdir(directory, { recursive: true });
    const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;

    if (kind === 'image') {
      const bytes = await fsApi.readFile(source);
      if (!hasExpectedImageSignature(bytes, extension)) throw httpError(400, '图片内容与扩展名不匹配或文件已损坏。');
      const destination = path.join(directory, `${targetPrefix}-wallpaper-${stamp}${extension}`);
      await atomicCreate(destination, bytes);
      const preview = await syncStaticPreview(destination);
      return {
        ok: true,
        kind,
        path: publicPathForRepoFile(destination),
        file: relativeToRepo(destination),
        sourceSize: stat.size,
        outputSize: stat.size,
        optimized: false,
        ...preview,
      };
    }

    const tools = await mediaToolsStatus();
    if (!tools.available) throw httpError(503, '没有找到 FFmpeg/FFprobe，暂时无法安全转换视频壁纸。');

    const input = await inspectMedia(source);
    const destination = path.join(directory, `${targetPrefix}-wallpaper-${stamp}.mp4`);
    const temporary = `${destination}.${randomUUID()}.tmp.mp4`;
    try {
      const result = await runner.run(ffmpegCommand, [
        '-hide_banner', '-loglevel', 'error', '-i', source,
        '-map', '0:v:0', '-vf', 'scale=w=min(1920\\,iw):h=-2:flags=lanczos,fps=30',
        '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '24',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1',
        '-y', temporary,
      ], { cwd: repoRoot, timeoutMs: 180_000, maxOutputBytes: 256 * 1024 });

      if (result.code !== 0) {
        const detail = result.timedOut
          ? '视频转换超过 180 秒，已终止。'
          : String(result.stderr || result.output || '未知错误').trim().slice(-500);
        throw httpError(result.timedOut ? 504 : 400, `视频转换失败：${detail}`);
      }

      await fsApi.rename(temporary, destination);
    } catch (error) {
      await fsApi.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }

    const outputStat = await fsApi.stat(destination);
    const output = await inspectMedia(destination);
    const preview = await syncStaticPreview(destination);

    const posterPath = destination.replace(/\.mp4$/i, '.poster.webp');
    const temporaryPoster = `${posterPath}.${randomUUID()}.tmp.webp`;
    let poster = null;
    try {
      const posterResult = await runner.run(ffmpegCommand, [
        '-hide_banner', '-loglevel', 'error', '-ss', '0.2', '-i', destination,
        '-frames:v', '1', '-vf', 'scale=w=min(1920\\,iw):h=-2:flags=lanczos',
        '-c:v', 'libwebp', '-quality', '78', '-compression_level', '4', '-y', temporaryPoster,
      ], { cwd: repoRoot, timeoutMs: 60_000, maxOutputBytes: 128 * 1024 });
      if (posterResult.code === 0) {
        await fsApi.rename(temporaryPoster, posterPath);
        const posterStat = await fsApi.stat(posterPath);
        const posterPreview = await syncStaticPreview(posterPath);
        poster = {
          path: publicPathForRepoFile(posterPath),
          file: relativeToRepo(posterPath),
          size: posterStat.size,
          ...posterPreview,
        };
      }
    } finally {
      await fsApi.rm(temporaryPoster, { force: true }).catch(() => {});
    }

    return {
      ok: true,
      kind,
      path: publicPathForRepoFile(destination),
      file: relativeToRepo(destination),
      sourceSize: stat.size,
      outputSize: outputStat.size,
      optimized: true,
      input,
      output,
      poster,
      ...preview,
    };
  }

  async function importUploadedVideo({ name, bytes, targetName }) {
    const extension = path.extname(name).toLowerCase();
    if (!mediaTargetNames.has(targetName) || !uploadVideoExtensions.has(extension)) {
      throw httpError(400, '视频壁纸支持 MP4、WebM、MOV、M4V、MKV 或 AVI。');
    }
    const temporaryRoot = path.join(repoRoot, '.admin-tmp');
    const temporary = path.join(temporaryRoot, `${randomUUID()}${extension}`);
    await fsApi.mkdir(temporaryRoot, { recursive: true });
    try {
      await fsApi.writeFile(temporary, bytes, { flag: 'wx' });
      return await importWallpaperMedia(temporary, targetName);
    } finally {
      await fsApi.rm(temporary, { force: true }).catch(() => {});
    }
  }

  return {
    mediaToolsStatus,
    inspectMedia,
    syncStaticPreview,
    importWallpaperMedia,
    importUploadedVideo,
  };
}
