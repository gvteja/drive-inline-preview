import {sameDocumentFragment} from './navigation.js';
import {documentBridge} from './bridge.js';
import {decodeText, resolveURL, toBase64, binaryBytes} from './mime.js';

const SAFE_DATA = /^data:(?:image\/[\w.+-]+|font\/[\w.+-]+|audio\/[\w.+-]+|video\/[\w.+-]+|application\/(?:font-[\w.+-]+|vnd\.ms-fontobject|x-font-[\w.+-]+|octet-stream))(?:[;,])/i;
const JS_TYPE = /^(?:(?:application|text)\/(?:x-)?(?:java|ecma)script|text\/jscript|application\/octet-stream)$/i;
const REMOVE = new Set(['iframe','frame','frameset','object','embed','applet','portal','fencedframe','base','meta']);
const MAX_OUTPUT = 64 * 1024 * 1024;
export function documentPolicy(allowRemoteScripts = false) {
  return `default-src 'none'; script-src 'unsafe-inline' data: blob:${allowRemoteScripts ? ' https:' : ''}; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' data: https:; img-src data: blob: https:; font-src data: blob: https:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
export function parseSrcset(value) {
  const entries = []; let i = 0;
  while (i < value.length) {
    while (/[\s,]/.test(value[i] || '') && i < value.length) i++;
    if (i >= value.length) break;
    const start = i, data = value.slice(i, i + 5).toLowerCase() === 'data:';
    while (i < value.length && !/\s/.test(value[i]) && (data || value[i] !== ',')) i++;
    let url = value.slice(start, i);
    if (url.endsWith(',')) { entries.push({url: url.replace(/,+$/, ''), descriptor: ''}); continue; }
    const descStart = i;
    while (i < value.length && value[i] !== ',') i++;
    const descriptor = value.slice(descStart, i).trim();
    if (url && (!descriptor || /^\d+(?:\.\d+)?[wxh]$/.test(descriptor))) entries.push({url, descriptor});
    i++;
  }
  return entries;
}
/** Creates interactive markup for the manifest-declared opaque sandbox ONLY.
 * Never assign this HTML to a same-origin extension document or srcdoc. */
export function makePreview(archive, {documentURLs = [], allowRemoteScripts = false, bridge = null} = {}) {
  const doc = new DOMParser().parseFromString(archive.html, 'text/html');
  const baseTag = doc.querySelector('base[href]');
  const base = baseTag ? resolveURL(baseTag.getAttribute('href'), archive.base) : archive.base;
  const stats = {inlineScripts: 0, embeddedScripts: 0, blocked: 0, frames: 0, embedded: 0};
  const cache = new Map(), scripts = new Map(); let outputBudget = 0;
  const warnings = [...archive.warnings];
  const tally = (s) => {
    outputBudget += s.length;
    if (outputBudget > MAX_OUTPUT) throw new Error('Expanded preview exceeds the 64 MiB safety limit.');
    return s;
  };
  function networkURL(ref, from) {
    try {
      const url = new URL(ref, from);
      if (!['https:', 'http:'].includes(url.protocol) || url.hostname.endsWith('.invalid') || url.username || url.password) return '';
      url.hash = ''; return url.href;
    } catch { return ''; }
  }
  function findResource(ref, from) {
    const noHash = ref.split('#')[0];
    return archive.resources.get(noHash) || archive.resources.get(resolveURL(noHash, from));
  }
  function asset(ref, from, depth = 0) {
    ref = (ref || '').trim();
    if (!ref) return '';
    if (ref.startsWith('#') || SAFE_DATA.test(ref)) return ref;
    const resource = findResource(ref, from);
    if (!resource) {
      const url = networkURL(ref, from);
      if (url.startsWith('https:')) return url + (ref.includes('#') ? '#' + ref.split('#').slice(1).join('#') : '');
      stats.blocked++; return '';
    }
    if (depth > 8) { stats.blocked++; return ''; }
    const suffix = ref.includes('#') ? '#' + ref.split('#').slice(1).join('#') : '';
    if (cache.has(resource)) return cache.get(resource) + suffix;
    const type = resource.type;
    if (!/^(?:image|font|audio|video)\//.test(type) && !/^application\/(?:font-|x-font-|vnd\.ms-fontobject|octet-stream)/.test(type) && type !== 'text/css') {
      stats.blocked++; return '';
    }
    cache.set(resource, '');
    let data = resource.bytes;
    if (type === 'text/css') data = new TextEncoder().encode(css(decodeText(data, resource.typeHeader), resource.url || from, depth + 1));
    const result = tally(`data:${type};base64,${toBase64(data)}`);
    cache.set(resource, result); stats.embedded++;
    return result + suffix;
  }
  function css(text, from, depth = 0) {
    // A bounded practical URL rewrite, not a full CSS parser. The sandbox CSP
    // still rejects unsupported schemes and resource types missed by this.
    return text.replace(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^)]*?))\s*\)/gi, (_, a, b, c) => {
      const url = asset(a ?? b ?? c, from, depth);
      return `url("${(url || 'data:,').replace(/"/g, '%22')}")`;
    }).replace(/@import\s+(?:"([^"\n]*)"|'([^'\n]*)')/gi, (_, a, b) => {
      const url = asset(a ?? b, from, depth);
      return url ? `@import url("${url.replace(/"/g, '%22')}")` : '@import url("data:text/css,")';
    });
  }
  function script(el) {
    const type = (el.getAttribute('type') || '').trim().toLowerCase();
    // JSON/import-map/data script elements are not remote executable loads.
    if (type && type !== 'module' && !JS_TYPE.test(type)) return;
    const ref = el.getAttribute('src') ?? el.getAttribute('href') ?? el.getAttribute('xlink:href');
    if (ref === null) {
      const type = (el.getAttribute('type') || '').trim().toLowerCase();
      if (!type || type === 'module' || JS_TYPE.test(type)) stats.inlineScripts++;
      return;
    }
    const resource = findResource(ref, base);
    if (resource && JS_TYPE.test(resource.type)) {
      el.setAttribute('src', tally('data:application/javascript;base64,' + toBase64(resource.bytes)));
      el.removeAttribute('href'); el.removeAttribute('xlink:href'); el.removeAttribute('integrity');
      el.removeAttribute('crossorigin'); stats.embeddedScripts++; return;
    }
    if (/^data:(?:text|application)\/(?:java|ecma)script[;,]/i.test(ref)) { stats.embeddedScripts++; return; }
    const url = networkURL(ref, base);
    const allowed = allowRemoteScripts && url.startsWith('https:');
    const key = url || ref.slice(0, 4096) || '(empty script URL)';
    scripts.set(key, {url: key, blocked: !allowed, reason: allowed ? 'HTTPS script permitted' : url.startsWith('https:') ? 'Remote scripts are off' : url.startsWith('http:') ? 'Insecure HTTP scripts stay blocked' : 'Unresolved or unsupported script URL'});
    if (!allowed) { el.remove(); return; }
    el.setAttribute('src', url); el.removeAttribute('href'); el.removeAttribute('xlink:href');
    el.setAttribute('referrerpolicy', 'no-referrer');
    // Preserve integrity/crossorigin/type/async/defer. Their browser checks are
    // not bypassed when the user permits remote scripts.
  }
  function sanitize(root) {
    for (const el of [...root.querySelectorAll('*')]) {
      if (!el.parentNode) continue;
      const tag = el.localName.toLowerCase();
      if (REMOVE.has(tag)) { if (['iframe','frame','object','embed'].includes(tag)) stats.frames++; el.remove(); continue; }
      if (tag === 'script') { script(el); continue; }
      if (tag === 'template') { sanitize(el.content); el.removeAttribute('shadowrootmode'); }
      if (tag === 'link') {
        if (!(el.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) { el.remove(); continue; }
        const ref = el.getAttribute('href') || '', resource = findResource(ref, base);
        if (resource?.type === 'text/css' || /^data:text\/css[;,]/i.test(ref)) {
          let text = '';
          try {
            if (resource) text = decodeText(resource.bytes, resource.typeHeader);
            else {
              const comma = ref.indexOf(',');
              const bytes = /;base64/i.test(ref.slice(0, comma)) ? binaryBytes(atob(ref.slice(comma + 1))) : new TextEncoder().encode(decodeURIComponent(ref.slice(comma + 1)));
              text = decodeText(bytes);
            }
          } catch { stats.blocked++; }
          const style = doc.createElement('style');
          if (el.hasAttribute('media')) style.setAttribute('media', el.getAttribute('media'));
          style.textContent = css(text, resource?.url || base); el.replaceWith(style); stats.embedded++; continue;
        }
        const url = networkURL(ref, base);
        if (!url.startsWith('https:')) { el.remove(); stats.blocked++; continue; }
        el.setAttribute('href', url); el.setAttribute('referrerpolicy', 'no-referrer');
        continue;
      }
      if (tag === 'style') el.textContent = css(el.textContent, base);
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        // Embedded on* handlers are deliberately kept; they execute only in
        // the opaque sandbox. Browser sandbox/CSP prohibits form submission.
        if (['action','formaction','target','formtarget','ping','download','srcdoc','autofocus','autoplay','nonce'].includes(name)) { el.removeAttribute(attr.name); continue; }
        if (name === 'style') { el.setAttribute('style', css(attr.value, base)); continue; }
        if (name === 'srcset') {
          const values = parseSrcset(attr.value).map(({url, descriptor}) => {
            const mapped = asset(url, base); return mapped ? `${mapped}${descriptor ? ' ' + descriptor : ''}` : '';
          }).filter(Boolean);
          if (values.length) el.setAttribute('srcset', values.join(', ')); else el.removeAttribute(attr.name);
          continue;
        }
        if (['src','poster','background','href','xlink:href'].includes(name)) {
          if ((tag === 'a' || tag === 'area') && name.endsWith('href')) {
            const href = sameDocumentFragment(attr.value, [base, archive.base, ...documentURLs]);
            if (href) el.setAttribute(attr.name, href);
            else { el.removeAttribute(attr.name); el.setAttribute('title', 'External page navigation disabled in this preview'); }
          } else { const mapped = asset(attr.value, base); if (mapped) el.setAttribute(attr.name, mapped); else el.removeAttribute(attr.name); }
        }
      }
      if (['img','source','video','audio'].includes(tag)) el.setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  sanitize(doc);
  // A saved exporter toolbar has DOM but no event listeners. Only remove its
  // frozen copy when THIS FILE includes its recognizable original initializer.
  // That original script then rebuilds its own toolbar. No substitute is added.
  const hasOriginalInitializer = [...doc.querySelectorAll('script:not([src])')].some((el) =>
    el.textContent.includes('ce-prompt-navigation') && el.textContent.includes('data-ce-prompt') &&
    /createElement\(['"]nav['"]\)/.test(el.textContent));
  if (hasOriginalInitializer && doc.getElementById('ce-prompt-navigation')) {
    doc.getElementById('ce-prompt-navigation').remove(); doc.body.removeAttribute('data-ce-prompt-nav-layout');
  }
  const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8');
  const policy = doc.createElement('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy'); policy.setAttribute('content', documentPolicy(allowRemoteScripts));
  const referrer = doc.createElement('meta'); referrer.setAttribute('name', 'referrer'); referrer.setAttribute('content', 'no-referrer');
  const nodes = [charset, policy, referrer];
  if (bridge) {
    const bootstrap = doc.createElement('script');
    const config = JSON.stringify({...bridge, documentURLs: [base, archive.base, ...documentURLs]}).replace(/</g, '\\u003c');
    bootstrap.textContent = `(${documentBridge.toString()})(${config});`.replace(/<\/script/gi, '<\\/script');
    nodes.push(bootstrap);
  }
  doc.head.prepend(...nodes);
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
  if (html.length > MAX_OUTPUT) throw new Error('Expanded preview exceeds the 64 MiB safety limit.');
  if (stats.blocked) warnings.push(`${stats.blocked} unsupported, insecure, or missing asset reference(s) blocked. HTTPS CSS, fonts and images are allowed.`);
  if (stats.frames) warnings.push(`${stats.frames} embedded frame/object(s) omitted.`);
  return {html, stats, scripts: [...scripts.values()], warnings: [...new Set(warnings)]};
}
