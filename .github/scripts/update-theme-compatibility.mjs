import { readFile, writeFile } from 'node:fs/promises';

const file = '.github/theme-compatibility.json';
const latest = process.argv[2] || '';
if (!/^[0-9a-f]{40}$/i.test(latest)) throw new Error('Expected a full upstream Git commit SHA.');

const compatibility = JSON.parse(await readFile(file, 'utf8'));
if (compatibility.ref.toLowerCase() === latest.toLowerCase()) {
  console.log('Theme compatibility pin is already current.');
  process.exit(0);
}

compatibility.ref = latest.toLowerCase();
await writeFile(file, `${JSON.stringify(compatibility, null, 2)}\n`);
console.log(`Updated the proposed theme compatibility pin to ${compatibility.ref}.`);
