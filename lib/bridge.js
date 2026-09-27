/** Runs INSIDE the file's opaque-origin sandbox, not the extension page.
 * This is a limited presentation bridge, not a security boundary: file code
 * shares this context and could falsify diagnostics. No prompt UI is created. */
export function documentBridge(options) {
  'use strict';
  const send = (type, fields = {}) => parent.postMessage({channel: 'DIP_DOCUMENT', id: options.id, type, ...fields}, options.parentOrigin === 'null' ? '*' : options.parentOrigin);
  const clean = (value) => {
    if (typeof value !== 'string' || !value.startsWith('#') || value.length > 4096) return '';
    if (value === '#') return '#';
    let id = value.slice(1);
    try { id = decodeURIComponent(id); } catch {}
    try { return '#' + encodeURIComponent(id); } catch { return ''; }
  };
  let last = '', selected = null, pendingInitial = options.fragment;
  const tracked = new Set();
  const emit = (fragment) => {
    fragment = clean(fragment);
    if (fragment && fragment !== last) { last = fragment; send('fragment', {fragment}); }
  };
  function target(fragment) {
    if (fragment === '#') return document.body;
    let id; try { id = decodeURIComponent(fragment.slice(1)); } catch { return null; }
    return document.getElementById(id) || document.getElementsByName(id)[0];
  }
  function go(fragment, notify = true) {
    fragment = clean(fragment);
    const el = fragment && target(fragment);
    if (!el) { if (notify) send('missing', {fragment}); return false; }
    pendingInitial = '';
    selected?.removeAttribute('data-dip-current-target'); selected = el;
    if (fragment !== '#') el.setAttribute('data-dip-current-target', '');
    for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === 'details') p.open = true;
    if (fragment === '#') window.scrollTo({top: 0, left: 0, behavior: 'instant'});
    else el.scrollIntoView({block: 'start', inline: 'nearest', behavior: 'instant'});
    emit(fragment);
    return true;
  }
  function localFragment(href) {
    if (typeof href !== 'string') return '';
    if (href.startsWith('#')) return clean(href);
    for (const base of [location.href, ...options.documentURLs]) {
      try {
        const a = new URL(href, base), b = new URL(base);
        if (a.hash && a.origin === b.origin && a.pathname === b.pathname && a.search === b.search) return clean(a.hash);
      } catch {}
    }
    return '';
  }
  // Observe the HTML's own prompt-navigation history changes. Opaque origins
  // can reject hash-only history writes. Report them without granting origin
  // access; unrelated history errors are not hidden.
  for (const name of ['replaceState', 'pushState']) {
    const original = history[name].bind(history);
    history[name] = function (state, title, url) {
      const fragment = url == null ? '' : localFragment(String(url));
      let result;
      try { result = original(state, title, url); }
      catch (error) { if (!fragment || error.name !== 'SecurityError') throw error; }
      if (fragment) { pendingInitial = ''; emit(fragment); }
      return result;
    };
  }
  window.addEventListener('hashchange', () => { pendingInitial = ''; emit(location.hash); });
  // Bubble after the HTML's own click handlers. Do not replace their navigation.
  window.addEventListener('click', (event) => {
    const a = event.target.closest?.('a[href],area[href]');
    if (!a || event.defaultPrevented) return;
    const fragment = localFragment(a.getAttribute('href'));
    event.preventDefault();
    if (fragment) go(fragment);
    else send('notice', {text: 'External page navigation is disabled in this preview.'});
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); send('escape'); }
  }, true);
  document.addEventListener('securitypolicyviolation', (event) => {
    if (!/^script-src(?:-elem)?$/.test(event.effectiveDirective) || !/^https?:\/\//i.test(event.blockedURI)) return;
    if (tracked.size >= 1000 || tracked.has(event.blockedURI)) return;
    tracked.add(event.blockedURI);
    send('blocked-script', {url: event.blockedURI});
  });
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== options.parentOrigin) return;
    const d = event.data;
    if (!d || d.channel !== 'DIP_DOCUMENT' || d.id !== options.id) return;
    if (d.type === 'fragment') go(d.fragment);
    if (d.type === 'zoom' && [0.75, 1, 1.25, 1.5].includes(d.value) && document.body) {
      document.body.style.zoom = String(d.value);
      window.dispatchEvent(new Event('resize'));
    }
    if (d.type === 'key' && ['ArrowUp', 'ArrowDown'].includes(d.key)) {
      // Let the HTML's own keyboard handler decide what to do.
      document.dispatchEvent(new KeyboardEvent('keydown', {key: d.key, altKey: true, bubbles: true, cancelable: true}));
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body) document.body.style.zoom = String(options.zoom);
    const style = document.createElement('style');
    style.textContent = '[data-dip-current-target]{outline:2px solid #7c6fcd;outline-offset:4px;scroll-margin-top:24px}@media print{[data-dip-current-target]{outline:none}}';
    document.head.append(style);
    // Most exports are ready now. Retry once after bounded loading for late
    // script-created targets; do not fight user navigation or remote images.
    if (pendingInitial && !go(pendingInitial, false)) {
      const initial = pendingInitial;
      setTimeout(() => { if (pendingInitial === initial) go(initial); }, 1500);
    }
    send('loaded');
  }, {once: true});
}
