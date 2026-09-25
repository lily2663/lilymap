import { promises as fs } from 'node:fs';

function ensureEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const seen = new Set();
  return entries.map((entry) => {
    const target = String(entry?.target || '');
    if (!target) throw new TypeError('transaction target is required');
    if (seen.has(target)) throw new TypeError(`duplicate transaction target: ${target}`);
    seen.add(target);
    return { target, content: entry.content };
  });
}

export function createFileTransactionService({
  stageFile,
  atomicWrite,
  scheduleBuild = () => {},
  fsApi = fs,
}) {
  if (typeof stageFile !== 'function' || typeof atomicWrite !== 'function') {
    throw new TypeError('stageFile and atomicWrite are required');
  }

  async function snapshotTarget(target) {
    try {
      return { existed: true, bytes: await fsApi.readFile(target) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { existed: false, bytes: null };
      throw error;
    }
  }

  async function replaceFiles(entries, { schedule = true } = {}) {
    const operations = ensureEntries(entries);
    if (!operations.length) return { changed: 0 };

    const prepared = [];
    const committed = [];
    try {
      // Stage every new file before touching any live destination.
      for (const operation of operations) {
        prepared.push({
          ...operation,
          temporary: await stageFile(operation.target, operation.content),
          before: null,
        });
      }

      // Snapshot the old state only after all staging succeeds.
      for (const operation of prepared) operation.before = await snapshotTarget(operation.target);

      try {
        for (const operation of prepared) {
          await fsApi.rename(operation.temporary, operation.target);
          committed.push(operation);
          operation.temporary = null;
        }
      } catch (error) {
        const rollbackErrors = [];
        for (const operation of committed.reverse()) {
          try {
            if (operation.before.existed) {
              await atomicWrite(operation.target, operation.before.bytes, { schedule: false });
            } else {
              await fsApi.rm(operation.target, { force: true });
            }
          } catch (rollbackError) {
            rollbackErrors.push({
              target: operation.target,
              message: rollbackError?.message || String(rollbackError),
            });
          }
        }
        if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
        throw error;
      }

      if (schedule) scheduleBuild();
      return { changed: operations.length };
    } finally {
      await Promise.all(prepared
        .filter((operation) => operation.temporary)
        .map((operation) => fsApi.rm(operation.temporary, { force: true }).catch(() => {})));
    }
  }

  return { replaceFiles };
}
