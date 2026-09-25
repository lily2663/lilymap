import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { createNeteaseService, parseNeteasePlaylistId } from '../src/services/netease-service.mjs';

test('playlist id parser accepts ids and approved NetEase URLs only', () => {
  assert.equal(parseNeteasePlaylistId('123456'), '123456');
  assert.equal(parseNeteasePlaylistId('https://music.163.com/playlist?id=123456'), '123456');
  assert.equal(parseNeteasePlaylistId('https://y.music.163.com/m/playlist?id=987654'), '987654');
  assert.equal(parseNeteasePlaylistId('https://evil.example/playlist?id=123456'), '');
  assert.equal(parseNeteasePlaylistId('../123456'), '');
});

test('playlist import persists normalized snapshot without storing cookie', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-netease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builtInLayoutsRoot = path.join(root, 'theme-layouts');
  const userLayoutsRoot = path.join(root, 'data', 'lily', 'layouts');
  await fsp.mkdir(builtInLayoutsRoot, { recursive: true });
  await fsp.writeFile(path.join(builtInLayoutsRoot, 'home.yaml'), 'kind: home\nslots:\n  main: []\n');

  const calls = [];
  const network = {
    requestJson: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        ok: true,
        json: {
          playlist: {
            name: 'Test',
            coverImgUrl: 'http://img.example/cover.jpg',
            tracks: [{
              id: 123,
              name: 'Song',
              ar: [{ name: 'Artist' }],
              al: { name: 'Album', picUrl: 'http://img.example/song.jpg' },
              dt: 1234,
            }],
          },
        },
      };
    },
    requestMetadataFollowing: async () => ({ status: 200, ok: true, url: '', headers: { get: () => 'audio/mpeg' } }),
  };
  const atomicWrite = async (target, content) => {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  };
  const service = createNeteaseService({
    repoRoot: root,
    userLayoutsRoot,
    builtInLayoutsRoot,
    atomicWrite,
    runBuild: async () => ({ code: 0, output: '', build: { status: 'success' } }),
    network,
    loadModuleRegistry: async () => ({}),
    snapshotLayout: async () => '',
    now: () => new Date('2026-09-25T00:00:00.000Z'),
  });

  const result = await service.importPlaylist({ playlistId: '123456', cookie: 'MUSIC_U=secret' });
  assert.equal(result.trackCount, 1);
  const target = path.join(root, 'data', 'lily', 'music', 'p123456.yaml');
  const raw = await fsp.readFile(target, 'utf8');
  assert.doesNotMatch(raw, /MUSIC_U|secret/);
  const parsed = YAML.parse(raw);
  assert.equal(parsed.cover, 'https://img.example/cover.jpg');
  assert.equal(parsed.tracks[0].source, 'https://music.163.com/song/media/outer/url?id=123.mp3');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.cookie, 'MUSIC_U=secret');
});

test('playlist import refuses redirects so login cookies never leave music.163.com', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilymap-netease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createNeteaseService({
    repoRoot: root,
    userLayoutsRoot: path.join(root, 'layouts'),
    builtInLayoutsRoot: path.join(root, 'theme-layouts'),
    atomicWrite: async () => {},
    runBuild: async () => ({ code: 0, build: {} }),
    network: {
      requestJson: async () => ({ status: 302, ok: false, json: {}, location: 'https://evil.example/' }),
      requestMetadataFollowing: async () => { throw new Error('unused'); },
    },
    loadModuleRegistry: async () => ({}),
    snapshotLayout: async () => '',
  });

  await assert.rejects(
    () => service.importPlaylist({ playlistId: '123456', cookie: 'MUSIC_U=secret' }),
    /重定向/,
  );
});
