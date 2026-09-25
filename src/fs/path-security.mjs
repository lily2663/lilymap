import fs from 'node:fs';
import path from 'node:path';

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalWithMissing(target) {
  let current = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const real = (fs.realpathSync.native || fs.realpathSync)(current);
  return path.resolve(real, ...missing);
}

export function resolveInside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, candidate);
  if (!contained(absoluteRoot, target)) return null;
  try {
    const canonicalRoot = canonicalWithMissing(absoluteRoot);
    const canonicalTarget = canonicalWithMissing(target);
    if (!canonicalRoot || !canonicalTarget || !contained(canonicalRoot, canonicalTarget)) return null;
    return target;
  } catch {
    return null;
  }
}
