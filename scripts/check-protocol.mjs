import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';

const themeRoot = process.env.LILY_TEST_THEME_PATH;
if (!themeRoot) throw new Error('Set LILY_TEST_THEME_PATH to the lily-epitaph checkout.');

function readObject(file, label) {
  const document = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length) throw new Error(`${label}: ${document.errors[0].message}`);
  const value = document.toJS({ mapAsMap: false });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a YAML mapping.`);
  return value;
}

const runtime = readObject(path.join(themeRoot, 'data/lily/runtime.yaml'), 'Lily Runtime');
if (runtime.protocol !== 'lily-module-protocol/v1') {
  throw new Error(`Unsupported Lily runtime protocol: ${runtime.protocol || '(missing)'}.`);
}

const schemaPath = path.join(themeRoot, 'docs/protocol/module-manifest.v1.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
const modulesPath = path.join(themeRoot, 'data/lily/modules');
let count = 0;

for (const entry of fs.readdirSync(modulesPath).filter((name) => name.endsWith('.yaml')).sort()) {
  const file = path.join(modulesPath, entry);
  const manifest = readObject(file, entry);
  if (!validate(manifest)) throw new Error(`${entry}: ${ajv.errorsText(validate.errors)}`);
  if (manifest.id !== path.basename(entry, '.yaml')) throw new Error(`${entry}: manifest id must match its filename.`);
  const partial = manifest.template?.partial || `lily/modules/${manifest.id}/render.html`;
  if (partial.startsWith('/') || partial.split('/').includes('..')) throw new Error(`${entry}: unsafe template path.`);
  if (!fs.existsSync(path.join(themeRoot, 'layouts/partials', partial))) throw new Error(`${entry}: template not found: ${partial}`);
  for (const asset of [...(manifest.assets?.styles || []), ...(manifest.assets?.scripts || [])]) {
    if (!fs.existsSync(path.join(themeRoot, 'assets', asset))) throw new Error(`${entry}: declared asset not found: ${asset}`);
  }
  count += 1;
}

console.log(`Lily protocol v1 check passed for ${count} built-in module manifests.`);
