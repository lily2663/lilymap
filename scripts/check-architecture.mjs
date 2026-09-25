import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(root, 'server.mjs');
const appPath = path.join(root, 'public', 'js', 'app.js');
const server = fs.readFileSync(serverPath, 'utf8');
const app = fs.readFileSync(appPath, 'utf8');
const errors = [];

const serverLines = server.split(/\r?\n/).length;
const appLines = app.split(/\r?\n/).length;

if (serverLines > 950) errors.push(`server.mjs grew back to ${serverLines} lines; move domain work into services/routes.`);
if (appLines > 900) errors.push(`public/js/app.js grew back to ${appLines} lines; move page work into features/.`);
if (/\bfetch\s*\(/.test(server)) errors.push('server.mjs must not perform raw network fetches; use a network adapter/service.');
if (/\bffmpeg\b|\bffprobe\b/i.test(server)) errors.push('server.mjs must not own FFmpeg/FFprobe logic; use media-service.');
if (/function\s+(?:importWallpaperMedia|importNeteasePlaylist|prepareImport|loadModuleRegistry|installSiteModule)\b/.test(server)) {
  errors.push('extracted service responsibilities reappeared in server.mjs.');
}
const spawnCalls = [...server.matchAll(/\bspawn\s*\(/g)].length;
if (spawnCalls > 1) errors.push(`server.mjs contains ${spawnCalls} spawn() calls; only browser launching may spawn directly.`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Architecture check passed: server.mjs ${serverLines} lines, app.js ${appLines} lines.`);
