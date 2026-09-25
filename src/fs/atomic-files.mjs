import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createAtomicFileService({ scheduleBuild = () => {}, httpError, relativeToRepo = (value) => value, fsApi = fs }) {
  async function stageFile(target, content) {
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    await fsApi.mkdir(directory, { recursive: true });
    const handle = await fsApi.open(temporary, 'wx');
    try {
      if (typeof content === 'string') await handle.writeFile(content, 'utf8');
      else await handle.writeFile(content);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await fsApi.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return temporary;
  }

  async function atomicWrite(target, content, { schedule = true } = {}) {
    const temporary = await stageFile(target, content);
    try {
      await fsApi.rename(temporary, target);
    } catch (error) {
      await fsApi.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    if (schedule) scheduleBuild();
  }

  async function atomicCreate(target, content) {
    const temporary = await stageFile(target, content);
    try {
      await fsApi.link(temporary, target);
    } catch (error) {
      if (error.code === 'EEXIST' || await fsApi.stat(target).then(() => true).catch(() => false)) {
        throw httpError(409, `同名资源已存在：${relativeToRepo(target)}。`);
      }
      throw error;
    } finally {
      await fsApi.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function copyWithoutClobber(source, target) {
    const bytes = await fsApi.readFile(source);
    try {
      await atomicCreate(target, bytes);
      return 'created';
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      const current = await fsApi.readFile(target).catch(() => null);
      if (current && current.equals(bytes)) return 'existing';
      throw httpError(409, `目标资源已存在且内容不同：${relativeToRepo(target)}。`);
    }
  }

  return { stageFile, atomicWrite, atomicCreate, copyWithoutClobber };
}
