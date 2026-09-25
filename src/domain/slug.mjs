export function safeSlug(input) {
  const slug = String(input || '').trim().replace(/\s+/g, '-');
  if (!slug || slug.length > 100 || /[\\/:*?"<>|]/.test(slug) || slug === '.' || slug === '..' || slug.includes('..')) return null;
  return slug;
}
