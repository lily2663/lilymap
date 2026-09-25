import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(target) {
  return MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
}

export function parseByteRange(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;

  if (!Number.isFinite(start) && Number.isFinite(end)) {
    if (end <= 0) return { invalid: true };
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = size - 1;
  }

  if (start < 0 || end < start || start >= size) return { invalid: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

export async function streamFile(req, res, target, headers = {}) {
  const stat = await fs.stat(target);
  const common = {
    'content-type': contentTypeFor(target),
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    ...headers,
  };

  const range = parseByteRange(req.headers.range, stat.size);
  if (range?.invalid) {
    res.writeHead(416, { ...common, 'content-range': `bytes */${stat.size}`, 'content-length': 0 });
    res.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      ...common,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fsSync.createReadStream(target, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, common);
  if (req.method === 'HEAD') return res.end();
  fsSync.createReadStream(target).pipe(res);
}
