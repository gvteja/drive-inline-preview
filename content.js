/* Runs only on drive.google.com, in Chrome's isolated content-script world. */
(() => {
  'use strict';
  if (globalThis.__driveInlinePreviewInstalled) return;
  globalThis.__driveInlinePreviewInstalled = true;
  const EXT = /\.(?:html?|mhtml|mht)$/i;
  const ID = /^[A-Za-z0-9_-]{10,200}$/;
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  let enabled = false; // Wait for the stored preference before intercepting.
  let overlay = null;
  let suppressed = '';
  let debounce = null;
  let lastURL = location.href;
  function validFragment(value) {
    return typeof value === 'string' && value.length <= 4096 && (value === '' || value.startsWith('#')) && !/[\r\n\0]/.test(value);
  }
  function routeKey(href) { const url = new URL(href); url.hash = ''; return url.href; }
  function directFileID() {
    const url = new URL(location.href);
    return /\/file\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1] ||
      (url.pathname === '/open' ? url.searchParams.get('id') : null);
  }
  function sendFragment(fragment) {
    if (!overlay?.target || !validFragment(fragment)) return;
    overlay.target.fragment = fragment;
    overlay.frame.contentWindow.postMessage({channel: 'DRIVE_INLINE_PREVIEW', nonce: overlay.nonce, action: 'fragment', fragment}, extensionOrigin);
  }

  const clean = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  function nameOptions(raw) {
    const value = clean(raw);
    if (!EXT.test(value) || value.length > 600) return [];
    const result = new Set([value]);
    for (let i = 1; i < value.length; i++) {
      if (/[ ,]/.test(value[i - 1])) {
        const tail = value.slice(i).trim();
        if (EXT.test(tail)) result.add(tail);
      }
    }
    return [...result].slice(0, 40);
  }
  function namesIn(element) {
    const result = new Set();
    const add = (value) => { for (const name of nameOptions(value)) result.add(name); };
    for (const node of [element, ...element.querySelectorAll('[aria-label],[data-tooltip],[data-tooltip-text],[title],[role="gridcell"]')]) {
      for (const attr of ['data-tooltip','data-tooltip-text','title','aria-label']) add(node.getAttribute(attr));
      if (node.getAttribute('role') === 'gridcell') add(node.textContent);
    }
    // File-name spans often have no attributes. Limit traversal to avoid reading
    // an entire source-code preview as a filename.
    const leaves = [...element.querySelectorAll('span')].slice(0, 150);
    for (const leaf of leaves) if (leaf.childElementCount === 0) add(leaf.textContent);
    return [...result].slice(0, 40);
  }
  function accountContext() {
    const url = new URL(location.href);
    return {
      account: url.searchParams.get('authuser') || /\/u\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] || '',
      resourceKey: url.searchParams.get('resourcekey') || ''
    };
  }
  function fromRow(row) {
    const id = row?.getAttribute('data-id');
    if (!ID.test(id || '')) return null;
    const names = namesIn(row);
    return names.length ? {id, names, ...accountContext()} : null;
  }
  function selected() {
    const rows = [...document.querySelectorAll('[aria-selected="true"][data-id]')];
    return rows.length === 1 ? fromRow(rows[0]) : null;
  }
  function direct() {
    const url = new URL(location.href);
    const id = /\/file\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1] ||
      (url.pathname === '/open' ? url.searchParams.get('id') : null);
    if (!ID.test(id || '')) return null;
    const title = document.title.replace(/\s*[-–—]\s*Google Drive\s*$/i, '');
    const names = nameOptions(title);
    return names.length ? {id, names, fragment: validFragment(url.hash) ? url.hash : '', ...accountContext()} : null;
  }
  function visible(element) {
    return !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0;
  }
  function inNativePreview() {
    const candidate = selected();
    if (!candidate) return null;
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!visible(dialog)) continue;
      const names = namesIn(dialog);
      if (names.some((name) => candidate.names.includes(name))) return candidate;
    }
    return null;
  }
  function close() {
    if (!overlay) return;
    suppressed = overlay.target?.id || '';
    const focused = overlay.previousFocus;
    overlay.host.remove();
    overlay = null;
    if (focused?.isConnected) focused.focus({preventScroll: true});
  }
  function show(target) {
    if (overlay?.target?.id === target?.id && overlay) {
      if (target && validFragment(target.fragment) && target.fragment !== overlay.target.fragment) sendFragment(target.fragment);
      return;
    }
    if (overlay) close();
    const previousFocus = document.activeElement;
    const host = document.createElement('div');
    // No file content or privileged controls are inserted into Drive's DOM.
    host.setAttribute('data-drive-inline-preview', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;background:#202124;';
    const shadow = host.attachShadow({mode: 'closed'});
    const frame = document.createElement('iframe');
    const nonce = crypto.randomUUID();
    const url = new URL(chrome.runtime.getURL('viewer.html'));
    if (target) url.searchParams.set('target', JSON.stringify(target));
    url.searchParams.set('nonce', nonce);
    frame.src = url.href;
    // Let the viewer's Copy button write after a user click. The document
    // sandbox inside the viewer explicitly denies clipboard access.
    frame.allow = 'clipboard-write';
    frame.title = 'HTML and MHTML file preview';
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = 'display:block;border:0;width:100%;height:100%;background:white;';
    shadow.append(frame);
    document.documentElement.append(host);
    overlay = {host, frame, target, nonce, previousFocus};
    frame.focus();
  }
  window.addEventListener('message', (event) => {
    if (!overlay || event.source !== overlay.frame.contentWindow || event.origin !== extensionOrigin) return;
    const data = event.data;
    if (data?.channel !== 'DRIVE_INLINE_PREVIEW' || data.nonce !== overlay.nonce) return;
    if (data.action === 'fragment' && overlay.target && validFragment(data.fragment)) {
      overlay.target.fragment = data.fragment;
      // Keep a folder in place. For a direct-file page only, update its hash
      // without a reload, without changing Drive's history.state object.
      if (directFileID() === overlay.target.id) {
        const url = new URL(location.href); url.hash = data.fragment;
        try { history.replaceState(history.state, '', url); lastURL = location.href; } catch {}
      }
    }
    // Reveal the Drive page already under the overlay. close() suppresses
    // automatic reopening of this file without changing the URL or reloading.
    if (data.action === 'close' || data.action === 'native') close();
  });
  document.addEventListener('keydown', (event) => {
    if (overlay) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      return;
    }
    if (!enabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['Enter', ' '].includes(event.key)) return;
    if (event.target.closest?.('input,textarea,select,button,a,[contenteditable="true"],[role="textbox"]')) return;
    const target = selected();
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    suppressed = '';
    show(target);
  }, true);
  document.addEventListener('dblclick', (event) => {
    if (!enabled || overlay || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = fromRow(event.target.closest?.('[data-id]'));
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    suppressed = '';
    show(target);
  }, true);
  function scan() {
    debounce = null;
    if (lastURL !== location.href) {
      const sameRoute = routeKey(lastURL) === routeKey(location.href);
      lastURL = location.href;
      if (sameRoute) {
        if (overlay?.target?.id === directFileID()) sendFragment(location.hash);
        else if (!overlay) suppressed = '';
      } else {
        if (overlay) close();
        suppressed = '';
      }
    }
    if (!enabled || overlay || new URL(location.href).searchParams.get('inlinePreview') === 'off') return;
    const target = direct() || inNativePreview();
    if (target && target.id !== suppressed) show(target);
    if (!target) suppressed = '';
  }
  const schedule = () => { if (!debounce) debounce = setTimeout(scan, 300); };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['aria-selected','aria-hidden','aria-label','data-id']
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'DIP_OPEN_SELECTED') { suppressed = ''; show(direct() || selected()); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.autoPreview) { enabled = changes.autoPreview.newValue !== false; schedule(); }
  });
  chrome.storage.local.get({autoPreview: true}).then((settings) => { enabled = settings.autoPreview; schedule(); });
})();
