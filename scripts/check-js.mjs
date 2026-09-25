import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const roots = ['src', 'public/js', 'scripts'];
const files = [path.join(root, 'server.mjs')];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(full);
  }
}

for (const directory of roots) walk(path.join(root, directory));

const unique = [...new Set(files)].sort();
const failures = [];
for (const file of unique) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    failures.push({
      file: path.relative(root, file).replaceAll('\\', '/'),
      output: (result.stderr || result.stdout || '').trim(),
    });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\n[${failure.file}]\n${failure.output}`);
  }
  process.exit(1);
}

console.log(`JavaScript syntax check passed for ${unique.length} source files.`);
