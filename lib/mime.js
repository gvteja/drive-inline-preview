/** Small, dependency-free MIME reader for common Chrome/Edge MHTML archives.
 * Not an email client. Deliberately rejects truncated or excessively nested input.
 */
const MAX_PARTS = 1000;
const MAX_DECODED = 48 * 1024 * 1024;
const MAX_DEPTH = 8;

export function binaryString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return out;
}
export function binaryBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
  return out;
}
export function toBase64(bytes) { return btoa(binaryString(bytes)); }
export function mediaType(value = '') { return value.split(';', 1)[0].trim().toLowerCase(); }
export function parameter(value, key) {
  const re = /;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]+))/g;
  let match;
  while ((match = re.exec(value || ''))) {
    if (match[1].toLowerCase() === key.toLowerCase()) return (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
  }
  return '';
}
export function splitEntity(raw) {
  const split = /\r?\n\r?\n/.exec(raw);
  if (!split) throw new Error('Malformed MHTML: a MIME header/body separator is missing.');
  const headers = {};
  const headerText = raw.slice(0, split.index).replace(/\r?\n[\t ]+/g, ' ');
  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).toLowerCase().trim();
    if (!(key in headers)) headers[key] = line.slice(colon + 1).trim();
  }
  return {headers, body: raw.slice(split.index + split[0].length)};
}
export function transferDecode(raw, encoding = '') {
  switch (encoding.trim().toLowerCase()) {
    case 'base64':
      try { return binaryBytes(atob(raw.replace(/\s/g, ''))); }
      catch { throw new Error('Malformed MHTML: invalid base64 content.'); }
    case 'quoted-printable':
      return binaryBytes(raw.replace(/=\r?\n/g, '').replace(/=([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
    case '': case '7bit': case '8bit': case 'binary': return binaryBytes(raw);
    default: throw new Error(`Unsupported MIME transfer encoding: ${encoding}`);
  }
}
export function decodeText(bytes, contentType = '', sniffHTML = false) {
  let encoding = parameter(contentType, 'charset');
  if (!encoding && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (!encoding && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  if (!encoding && sniffHTML) {
    const head = binaryString(bytes.subarray(0, 8192));
    encoding = /<meta\b[^>]*charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] || '';
  }
  try { return new TextDecoder(encoding || 'utf-8').decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}
export function resolveURL(ref, base) {
  try { return new URL(ref, base || 'https://archive.invalid/').href; }
  catch { return ref; }
}
const cid = (s = '') => s.trim().replace(/^<|>$/g, '');

export function parseMHTML(bytes) {
  const raw = binaryString(bytes);
  const top = splitEntity(raw);
  const topType = top.headers['content-type'] || '';
  if (!/^multipart\//i.test(topType)) throw new Error('This is not a supported multipart MHTML archive.');
  const start = cid(parameter(topType, 'start'));
  const parts = [];
  const warnings = [];
  let decoded = 0;
  const topBase = top.headers['snapshot-content-location'] || top.headers['content-location'] || 'https://archive.invalid/';
  function walk(entity, depth, inheritedBase) {
    if (depth > MAX_DEPTH) throw new Error('MHTML nesting exceeds the safety limit.');
    const {headers, body} = entity;
    const typeHeader = headers['content-type'] || 'application/octet-stream';
    const type = mediaType(typeHeader);
    const base = headers['content-base'] ? resolveURL(headers['content-base'], inheritedBase) : inheritedBase;
    if (type.startsWith('multipart/')) {
      const boundary = parameter(typeHeader, 'boundary');
      if (!boundary || boundary.length > 200) throw new Error('MHTML boundary is missing or invalid.');
      const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const delimiter = new RegExp('(?:^|\\r?\\n)--' + escaped + '(--)?[ \\t]*(?:\\r?\\n|$)', 'g');
      let match, previousEnd = null, closed = false, childCount = 0;
      while ((match = delimiter.exec(body))) {
        if (previousEnd !== null) {
          walk(splitEntity(body.slice(previousEnd, match.index)), depth + 1, base);
          childCount++;
        }
        if (match[1]) { closed = true; break; }
        previousEnd = delimiter.lastIndex;
      }
      if (!closed || !childCount) throw new Error('MHTML archive is incomplete: closing boundary or content is missing.');
      return;
    }
    if (parts.length >= MAX_PARTS) throw new Error('MHTML exceeds the 1,000-part safety limit.');
    const data = transferDecode(body, headers['content-transfer-encoding']);
    decoded += data.length;
    if (decoded > MAX_DECODED) throw new Error('Decoded MHTML exceeds the safety limit.');
    const location = headers['content-location'] || '';
    parts.push({headers, typeHeader, type, bytes: data, cid: cid(headers['content-id']),
      location, url: location ? resolveURL(location, base) : '', base});
  }
  walk(top, 0, topBase);
  const root = (start && parts.find((p) => p.cid === start)) || parts.find((p) => p.type === 'text/html');
  if (!root || root.type !== 'text/html') throw new Error('The MHTML archive has no supported HTML root.');
  const base = root.url || topBase;
  const resources = new Map();
  for (const part of parts) {
    if (part === root) continue;
    const keys = [];
    if (part.cid) keys.push('cid:' + part.cid);
    if (part.location) keys.push(part.location, part.url, resolveURL(part.location, base));
    for (const key of new Set(keys)) {
      if (resources.has(key) && resources.get(key) !== part) warnings.push('Duplicate archive resource location; the first entry was used.');
      else resources.set(key, part);
    }
  }
  if (parts.some((p) => p !== root && p.type === 'text/html')) warnings.push('Embedded HTML frames are omitted in this preview.');
  return {html: decodeText(root.bytes, root.typeHeader, true), base, resources, partCount: parts.length, warnings};
}
export function readDocument(bytes, name, contentType = '') {
  if (/\.(?:mhtml|mht)$/i.test(name) || /^(?:multipart\/related|application\/x-mimearchive)/i.test(contentType)) {
    return parseMHTML(bytes);
  }
  return {html: decodeText(bytes, contentType, true), base: 'https://archive.invalid/', resources: new Map(), partCount: 1, warnings: []};
}
