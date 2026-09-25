import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

const ITERATIONS = 600000;
const MAX_CIPHERTEXT_BYTES = 5 * 1024 * 1024;

function invalidProtectedContent(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function decodeBase64(value, label, expectedLength = null, maxLength = Infinity) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw invalidProtectedContent(`${label} 编码无效。`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (expectedLength != null && bytes.length !== expectedLength) throw invalidProtectedContent(`${label} 长度无效。`);
  if (bytes.length > maxLength) throw invalidProtectedContent(`${label} 内容过大。`);
  return bytes;
}

export function validateProtectedPayload(payload, expectedId = '') {
  if (!payload || typeof payload !== 'object' || payload.version !== 2) throw invalidProtectedContent('加密文章格式不受支持。');
  if (typeof payload.pageId !== 'string' || (expectedId && payload.pageId !== expectedId)) throw invalidProtectedContent('加密文章 ID 不匹配。');
  if (payload.kdf?.name !== 'PBKDF2' || payload.kdf?.hash !== 'SHA-256' || payload.kdf?.iterations !== ITERATIONS) {
    throw invalidProtectedContent('加密文章 KDF 参数不受支持。');
  }
  if (payload.cipher?.name !== 'AES-256-GCM') throw invalidProtectedContent('加密文章算法不受支持。');
  if (payload.publicStubHash != null && (typeof payload.publicStubHash !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.publicStubHash))) {
    throw invalidProtectedContent('公开占位内容校验值无效。');
  }
  return {
    salt: decodeBase64(payload.kdf.salt, 'salt', 16),
    iv: decodeBase64(payload.cipher.iv, 'iv', 12),
    data: decodeBase64(payload.cipher.data, 'ciphertext', null, MAX_CIPHERTEXT_BYTES),
    tag: decodeBase64(payload.cipher.tag, 'tag', 16),
  };
}

export function encryptProtectedBody(id, body, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  return {
    version: 2,
    pageId: id,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: salt.toString('base64') },
    cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
  };
}

export function decryptProtectedBody(payload, password, expectedId = '') {
  const encoded = validateProtectedPayload(payload, expectedId);
  try {
    const key = pbkdf2Sync(password, encoded.salt, ITERATIONS, 32, 'sha256');
    const decipher = createDecipheriv('aes-256-gcm', key, encoded.iv);
    decipher.setAuthTag(encoded.tag);
    return Buffer.concat([decipher.update(encoded.data), decipher.final()]).toString('utf8');
  } catch {
    throw invalidProtectedContent('密码错误或加密文章已损坏。');
  }
}
