import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { resolveInside } from '../fs/path-security.mjs';
import { normalizeLayout, parseLayout, validateLayoutAgainstRegistry } from '../domain/layout.mjs';
import { parseYaml } from '../domain/value.mjs';

export function parseNeteasePlaylistId(input) {
  const value = String(input || '').trim();
  if (/^\d{5,20}$/.test(value)) return value;
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (!['music.163.com', 'y.music.163.com'].includes(parsed.hostname.toLowerCase())) return '';
    const id = parsed.searchParams.get('id') || parsed.hash.match(/[?&]id=(\d+)/)?.[1] || '';
    return /^\d{5,20}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

function playlistError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function createNeteaseService({
  repoRoot,
  userLayoutsRoot,
  builtInLayoutsRoot,
  atomicWrite,
  runBuild,
  network,
  loadModuleRegistry,
  snapshotLayout,
  fsApi = fs,
  now = () => new Date(),
}) {
  const musicRoot = path.join(repoRoot, 'data', 'lily', 'music');
  const exists = async (target) => {
    try { await fsApi.access(target); return true; } catch { return false; }
  };
  const relativeToRepo = (target) => path.relative(repoRoot, target).split(path.sep).join('/');
  const snapshotPath = (playlistId) => resolveInside(musicRoot, `p${playlistId}.yaml`);

  async function activePlaylistId() {
    const target = path.join(userLayoutsRoot, 'home.yaml');
    const source = await exists(target) ? target : path.join(builtInLayoutsRoot, 'home.yaml');
    if (!(await exists(source))) return '';
    const layout = parseLayout(await fsApi.readFile(source, 'utf8'), '首页布局');
    for (const instances of Object.values(layout.slots)) {
      const music = instances.find((instance) => instance.module === 'music' && instance.enabled !== false);
      if (music) return String(music.config?.playlistId || '');
    }
    return '';
  }

  async function activatePlaylist(rawPlaylistId, { build = true } = {}) {
    const playlistId = parseNeteasePlaylistId(rawPlaylistId);
    if (!playlistId) throw playlistError('请输入正确的网易云歌单 ID。');
    const snapshot = snapshotPath(playlistId);
    if (!snapshot || !(await exists(snapshot))) throw playlistError('该歌单尚未导入，请先同步歌单。');

    const target = path.join(userLayoutsRoot, 'home.yaml');
    const source = await exists(target) ? target : path.join(builtInLayoutsRoot, 'home.yaml');
    if (!(await exists(source))) throw playlistError('未找到首页布局，请先在页面布局中添加 Lily Radio。');

    const document = YAML.parseDocument(await fsApi.readFile(source, 'utf8'), { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length) throw playlistError(`首页布局 YAML 无效：${document.errors[0].message}`);
    const layout = normalizeLayout(document.toJS({ mapAsMap: false }), '首页布局');
    const instances = Object.entries(layout.slots)
      .flatMap(([slot, items]) => items.map((item, index) => ({ slot, item, index })));
    const music = instances.filter(({ item }) => item.module === 'music' && item.enabled !== false);
    if (!music.length) throw playlistError('首页没有启用的 Lily Radio；请先在页面布局中添加模块。');

    const previousPlaylistId = String(music[0].item.config?.playlistId || '');
    for (const { slot, index } of music) {
      document.setIn(['slots', slot, index, 'config', 'playlistId'], playlistId);
    }
    const updated = parseLayout(String(document), '首页布局');
    validateLayoutAgainstRegistry(updated, await loadModuleRegistry());
    if (await exists(target)) await snapshotLayout('home', target);
    await atomicWrite(target, String(document), { schedule: false });

    if (build) {
      const result = await runBuild(false, 'netease-activate');
      if (result.code !== 0) throw playlistError(`歌单已设为当前歌单，但博客构建失败：${result.output || '请查看系统诊断。'}`, 500);
    }
    return { playlistId, previousPlaylistId, active: true };
  }

  async function importPlaylist(request) {
    const playlistId = parseNeteasePlaylistId(request?.playlistId);
    if (!playlistId) throw playlistError('请输入正确的网易云歌单 ID。');

    const cookie = String(request?.cookie || '')
      .trim()
      .replace(/^cookie\s*:\s*/i, '')
      .replace(/\\([_*])/g, '$1');
    if (cookie.length > 8192 || /[\r\n\0]/.test(cookie)) throw playlistError('Cookie 格式无效。');

    let result;
    try {
      result = await network.requestJson(
        `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=1000&s=0`,
        {
          allowedHosts: ['music.163.com'],
          headers: {
            accept: 'application/json, text/plain, */*',
            cookie,
            referer: `https://music.163.com/playlist?id=${encodeURIComponent(playlistId)}`,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LilyMap/1.0',
          },
          redirect: 'manual',
          timeoutMs: 20_000,
          maxBytes: 8 * 1024 * 1024,
        },
      );
    } catch (error) {
      if (error?.code === 'TIMEOUT' || error?.code === 'CONNECT_FAILED') {
        throw playlistError('连接网易云超时或失败，请检查网络后重试。', 503);
      }
      if (error?.code === 'BODY_TOO_LARGE') throw playlistError(error.message, 502);
      if (error?.code === 'INVALID_JSON') throw playlistError('网易云返回了无法识别的数据。', 502);
      throw error;
    }

    if (result.status >= 300 && result.status < 400) {
      throw playlistError('网易云接口返回了重定向；为避免登录 Cookie 被转发到其他地址，已停止导入。', 502);
    }
    if (!result.ok) throw playlistError(`网易云返回 HTTP ${result.status}，请稍后重试。`, 502);

    const payload = result.json;
    const playlist = payload?.playlist || payload?.result;
    if (!playlist || !Array.isArray(playlist.tracks)) {
      if (payload?.code === 401 || payload?.code === 20001) {
        throw playlistError(cookie
          ? '网易云拒绝访问这个隐私歌单。当前 Cookie 未获得访问权限或已经过期，请在网易云重新登录后复制完整 Cookie。原有歌单快照不会被覆盖。'
          : '这是隐私歌单。请填写有访问权限且仍有效的网易云登录 Cookie，或把歌单设为公开。原有歌单快照仍可使用。', 401);
      }
      throw playlistError(String(payload?.message || payload?.msg || '没有读取到歌单；请检查歌单 ID 与 Cookie。').slice(0, 180));
    }

    const tracks = playlist.tracks.slice(0, 500).map((track) => {
      const id = String(track?.id || '').trim();
      const artists = track?.ar || track?.artists || [];
      const album = track?.al || track?.album || {};
      return {
        id,
        title: String(track?.name || '未命名音乐').slice(0, 160),
        artist: artists.map((artist) => String(artist?.name || '')).filter(Boolean).join(' / ').slice(0, 200),
        album: String(album?.name || '').slice(0, 160),
        cover: String(album?.picUrl || '').replace(/^http:/i, 'https:').slice(0, 1000),
        duration: Number(track?.dt || track?.duration || 0),
        source: `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`,
      };
    }).filter((track) => /^\d{1,20}$/.test(track.id));
    if (!tracks.length) throw playlistError('歌单中没有可导入的歌曲。');

    const snapshot = {
      provider: 'netease',
      playlistId,
      name: String(playlist.name || `网易云歌单 ${playlistId}`).slice(0, 160),
      cover: String(playlist.coverImgUrl || '').replace(/^http:/i, 'https:').slice(0, 1000),
      importedAt: now().toISOString(),
      tracks,
    };
    const target = snapshotPath(playlistId);
    if (!target) throw playlistError('歌单保存路径无效。');
    if (await exists(target)) {
      const previous = parseYaml(await fsApi.readFile(target, 'utf8'), `歌单 ${playlistId}`);
      const availableIds = new Set(tracks.map((track) => track.id));
      snapshot.excludedTrackIds = Array.isArray(previous.excludedTrackIds)
        ? previous.excludedTrackIds.map(String).filter((id) => availableIds.has(id))
        : [];
    }

    await atomicWrite(target, YAML.stringify(snapshot), { schedule: false });
    const activated = request?.activate === true;
    if (activated) await activatePlaylist(playlistId, { build: false });
    const build = await runBuild(false, 'netease-playlist');
    if (build.code !== 0) {
      throw playlistError(`歌单已保存${activated ? '并设为当前歌单' : ''}，但博客构建失败：${build.output || '请查看系统诊断。'}`, 500);
    }
    return {
      playlistId,
      name: snapshot.name,
      trackCount: tracks.length,
      path: relativeToRepo(target),
      activated,
      build: build.build,
    };
  }

  async function snapshotStatus(rawPlaylistId) {
    const playlistId = parseNeteasePlaylistId(rawPlaylistId);
    if (!playlistId) throw playlistError('请输入正确的网易云歌单 ID。');
    const active = await activePlaylistId();
    const target = snapshotPath(playlistId);
    if (!target || !(await exists(target))) {
      return { exists: false, playlistId, trackCount: 0, activePlaylistId: active, active: playlistId === active };
    }
    const snapshot = parseYaml(await fsApi.readFile(target, 'utf8'), `歌单 ${playlistId}`);
    const stat = await fsApi.stat(target);
    const trackCount = Array.isArray(snapshot.tracks) ? snapshot.tracks.length : 0;
    const excludedCount = Array.isArray(snapshot.excludedTrackIds) ? snapshot.excludedTrackIds.length : 0;
    return {
      exists: true,
      playlistId,
      activePlaylistId: active,
      active: playlistId === active,
      name: String(snapshot.name || `网易云歌单 ${playlistId}`).slice(0, 160),
      trackCount,
      excludedCount,
      playableCount: Math.max(0, trackCount - excludedCount),
      importedAt: snapshot.importedAt || stat.mtime.toISOString(),
      path: relativeToRepo(target),
    };
  }

  async function snapshotTracks(rawPlaylistId) {
    const playlistId = parseNeteasePlaylistId(rawPlaylistId);
    if (!playlistId) throw playlistError('请输入正确的网易云歌单 ID。');
    const target = snapshotPath(playlistId);
    if (!target || !(await exists(target))) throw playlistError('该歌单尚未导入。', 404);
    const snapshot = parseYaml(await fsApi.readFile(target, 'utf8'), `歌单 ${playlistId}`);
    if (!Array.isArray(snapshot.tracks)) throw playlistError('歌单快照缺少歌曲列表。');
    const excludedTrackIds = Array.isArray(snapshot.excludedTrackIds) ? snapshot.excludedTrackIds.map(String) : [];
    return {
      playlistId,
      name: String(snapshot.name || `网易云歌单 ${playlistId}`),
      tracks: snapshot.tracks.map((track) => ({
        id: String(track.id),
        title: String(track.title || ''),
        artist: String(track.artist || ''),
      })),
      excludedTrackIds,
    };
  }

  async function checkTrackAvailability(request) {
    const snapshot = await snapshotTracks(request?.playlistId);
    const trackIds = request?.trackIds;
    if (!Array.isArray(trackIds) || trackIds.length < 1 || trackIds.length > 8) {
      throw playlistError('每次只能检测 1–8 首歌曲。');
    }
    const known = new Set(snapshot.tracks.map((track) => track.id));
    if (!trackIds.every((id) => typeof id === 'string' && known.has(id))) {
      throw playlistError('检测列表包含不属于该歌单的歌曲。');
    }

    const results = await Promise.all(trackIds.map(async (id) => {
      try {
        const response = await network.requestMetadataFollowing(
          `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`,
          {
            allowedHosts: ['music.163.com'],
            allowHostname: (host) => /^[a-z0-9.-]+\.music\.126\.net$/.test(host),
            timeoutMs: 10_000,
          },
        );
        const type = String(response.headers.get('content-type') || '').toLowerCase();
        const state = response.ok && type.startsWith('audio/') ? 'playable'
          : response.url.includes('/404') || type.includes('text/html') || response.status === 404 ? 'unavailable'
            : 'unknown';
        return { id, state };
      } catch {
        return { id, state: 'unknown' };
      }
    }));
    return { playlistId: snapshot.playlistId, results };
  }

  async function saveExclusions(request) {
    const snapshot = await snapshotTracks(request?.playlistId);
    const ids = request?.excludedTrackIds;
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === 'string')) {
      throw playlistError('剔除列表格式无效。');
    }
    const known = new Set(snapshot.tracks.map((track) => track.id));
    const excludedTrackIds = [...new Set(ids)];
    if (!excludedTrackIds.every((id) => known.has(id))) throw playlistError('剔除列表包含不属于该歌单的歌曲。');
    if (excludedTrackIds.length >= snapshot.tracks.length) throw playlistError('请至少保留一首歌曲供博客播放。');

    const target = snapshotPath(snapshot.playlistId);
    const document = YAML.parseDocument(await fsApi.readFile(target, 'utf8'), { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length) throw playlistError(`歌单 YAML 无效：${document.errors[0].message}`);
    document.set('excludedTrackIds', excludedTrackIds);
    await atomicWrite(target, String(document), { schedule: false });
    const build = await runBuild(false, 'netease-exclusions');
    if (build.code !== 0) throw playlistError(`剔除设置已保存，但博客构建失败：${build.output || '请查看系统诊断。'}`, 500);
    return {
      playlistId: snapshot.playlistId,
      total: snapshot.tracks.length,
      excludedCount: excludedTrackIds.length,
      playableCount: snapshot.tracks.length - excludedTrackIds.length,
    };
  }

  async function listSnapshots() {
    if (!(await exists(musicRoot))) return { activePlaylistId: await activePlaylistId(), playlists: [] };
    const active = await activePlaylistId();
    const files = (await fsApi.readdir(musicRoot))
      .filter((name) => /^p\d{5,20}\.yaml$/.test(name))
      .sort();
    const playlists = await Promise.all(files.map((name) => snapshotStatus(name.slice(1, -5))));
    playlists.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
    return { activePlaylistId: active, playlists };
  }

  return {
    importPlaylist,
    activePlaylistId,
    activatePlaylist,
    snapshotStatus,
    snapshotTracks,
    checkTrackAvailability,
    saveExclusions,
    listSnapshots,
  };
}
