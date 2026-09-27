/* This manifest-declared sandbox has an opaque origin and no extension APIs.
 * Accept exactly one render from its parent; no downloads, storage, or RPC. */
(() => {
  'use strict';
  const id = location.hash.slice(1);
  const parentOrigin = location.protocol === 'chrome-extension:' ? `chrome-extension://${location.host}` : new URL(location.href).origin;
  if (!/^[a-f0-9]{32}$/.test(id)) return;
  function receive(event) {
    if (event.source !== parent || event.origin !== parentOrigin) return;
    const data = event.data;
    if (!data || data.channel !== 'DIP_DOCUMENT' || data.id !== id || data.type !== 'render') return;
    if (typeof data.html !== 'string' || data.html.length > 64 * 1024 * 1024) return;
    window.removeEventListener('message', receive);
    // Clears the bootstrap DOM/listeners, but retains response/manifest CSP and
    // the browser's opaque-origin sandbox. File policy is also in the new HTML.
    document.open();
    document.write(data.html);
    document.close();
  }
  window.addEventListener('message', receive);
  parent.postMessage({channel: 'DIP_DOCUMENT', id, type: 'ready'}, parentOrigin === 'null' ? '*' : parentOrigin);
})();
