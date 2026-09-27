/** URL-only helpers. Document interaction lives in the isolated sandbox. */
export function normalizeFragment(value) {
  if (typeof value !== 'string' || !value.startsWith('#') || value.length > 4096) return '';
  if (value === '#') return '#';
  let id = value.slice(1);
  try { id = decodeURIComponent(id); } catch { /* A literal percent is a valid ID. */ }
  try { return '#' + encodeURIComponent(id); } catch { return ''; }
}

/** Only same-document links become local navigation; never arbitrary URLs. */
export function sameDocumentFragment(href, bases = []) {
  if (typeof href !== 'string') return '';
  href = href.trim();
  if (href.startsWith('#')) return normalizeFragment(href);
  for (const base of bases) {
    try {
      const url = new URL(href, base), reference = new URL(base);
      if (url.hash && url.origin === reference.origin && url.pathname === reference.pathname && url.search === reference.search) {
        return normalizeFragment(url.hash);
      }
    } catch { /* Relative or unavailable base; try the next known document URL. */ }
  }
  return '';
}

export function driveMessageURL(target, fragment = '') {
  if (!target || !/^[A-Za-z0-9_-]{10,200}$/.test(target.id || '')) return '';
  const url = new URL(`https://drive.google.com/file/d/${target.id}/view`);
  if (typeof target.account === 'string' && target.account) url.searchParams.set('authuser', target.account);
  if (typeof target.resourceKey === 'string' && target.resourceKey) url.searchParams.set('resourcekey', target.resourceKey);
  url.hash = normalizeFragment(fragment);
  return url.href;
}
