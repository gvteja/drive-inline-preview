/** Session-authenticated downloads; no API keys or OAuth tokens. */
export const MAX_BYTES = 32 * 1024 * 1024;
export const SUPPORTED = /\.(?:html?|mhtml|mht)$/i;
export const VALID_ID = /^[A-Za-z0-9_-]{10,200}$/;
const HOSTS = new Set(['drive.google.com', 'drive.usercontent.google.com']);

export function downloadURL({id, account = '', resourceKey = ''}) {
  if (!VALID_ID.test(id || '')) throw new Error('Invalid Google Drive file ID.');
  const url = new URL('https://drive.usercontent.google.com/download');
  url.searchParams.set('id', id);
  url.searchParams.set('export', 'download');
  if (account && /^[\w@.+-]{1,150}$/.test(account)) url.searchParams.set('authuser', account);
  if (resourceKey && /^[\w-]{1,200}$/.test(resourceKey)) url.searchParams.set('resourcekey', resourceKey);
  return url.href;
}

export function responseFilename(value = '') {
  // RFC 5987/6266 UTF-8 filenames take precedence over the ASCII fallback.
  const encoded = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value);
  if (encoded) {
    const token = encoded[1].trim().replace(/^"|"$/g, '');
    const match = /^utf-8'[^']*'(.*)$/i.exec(token);
    if (match) { try { return decodeURIComponent(match[1]); } catch {} }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(value);
  return plain ? (plain[1] ?? plain[2]).replace(/\\(["\\])/g, '$1').trim() : '';
}

export async function readLimited(response, limit = MAX_BYTES) {
  const advertised = Number(response.headers.get('content-length') || 0);
  if (advertised > limit) throw new Error('This file exceeds the 32 MiB preview limit.');
  if (!response.body) throw new Error('Drive returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('This file exceeds the 32 MiB preview limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function downloadFile(target, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(downloadURL(target), {
      credentials: 'include', redirect: 'follow', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal
    });
    if (response.url && !HOSTS.has(new URL(response.url).hostname)) {
      throw new Error('Google returned a sign-in page. Use the correct signed-in Chrome profile.');
    }
    if (!response.ok) {
      throw new Error(`Drive returned HTTP ${response.status}. Check the account and download permission. Google may also be blocking automated downloads.`);
    }
    const name = responseFilename(response.headers.get('content-disposition') || '');
    // Never mistake an HTTP-200 permission/virus-scan page for the actual file.
    if (!name) throw new Error('Drive did not return a verified file download. Open Drive preview to check for an account, permission, or download-confirmation page.');
    if (!SUPPORTED.test(name)) throw new Error('The downloaded file is not HTML or MHTML.');
    const normalize = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (target.names?.length && !target.names.some((n) => normalize(n) === normalize(name))) {
      throw new Error('The downloaded filename does not match the selected item. Preview was stopped to avoid showing the wrong file. Try its direct Drive file link.');
    }
    return {bytes: await readLimited(response), name, contentType: response.headers.get('content-type') || ''};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The download timed out. Retry or use the local-file button.');
    throw error;
  } finally { clearTimeout(timer); }
}
