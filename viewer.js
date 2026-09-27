import {driveMessageURL, normalizeFragment} from './lib/navigation.js';
import {MAX_BYTES, downloadFile, SUPPORTED, VALID_ID} from './lib/download.js';
import {readDocument, decodeText} from './lib/mime.js';
import {makePreview} from './lib/render.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let target = null;
try {
  const requested = JSON.parse(params.get('target') || 'null');
  if (requested && VALID_ID.test(requested.id || '')) {
    target = {id: requested.id, fragment: normalizeFragment(requested.fragment || ''), account: requested.account || '', resourceKey: requested.resourceKey || '',
      names: Array.isArray(requested.names) ? requested.names.filter((x) => typeof x === 'string' && x.length < 500).slice(0, 40) : []};
  }
} catch { /* The local-file viewer also works without a target. */ }
const nonce = params.get('nonce') || '';
const viewerOrigin = location.protocol === 'chrome-extension:' ? `chrome-extension://${location.host}` : location.origin;
let current = null, sequence = 0, session = null, startupTimer = 0;
let currentFragment = target?.fragment || normalizeFragment(location.hash), localFile = false;
let scriptRecords = new Map(), stats = null;

function navigationStatus(text = '') {
  $('navigation-status').textContent = text;
  $('navigation-status').hidden = !text;
}
function parentAction(action, details = {}) {
  if (parent !== window) parent.postMessage({channel: 'DRIVE_INLINE_PREVIEW', nonce, action, ...details}, 'https://drive.google.com');
  else if (action === 'close') window.close();
}
function sendDocument(type, fields = {}) {
  if (!session) return;
  // An opaque origin can only be addressed with '*'. The Window reference and
  // render-specific ID scope this to the current document. No privileged RPC.
  $('document').contentWindow?.postMessage({channel: 'DIP_DOCUMENT', id: session.id, type, ...fields}, '*');
}
function setFragment(fragment, notify = true) {
  currentFragment = normalizeFragment(fragment);
  if (target && !localFile) target.fragment = currentFragment;
  $('copy-link').disabled = !currentFragment;
  $('link-text').hidden = true; navigationStatus();
  if (!notify || localFile) return;
  if (parent !== window && target) parentAction('fragment', {fragment: currentFragment});
  else { try { const url = new URL(location.href); url.hash = currentFragment; history.replaceState(history.state, '', url); } catch {} }
}
function jumpFromURL(fragment) {
  currentFragment = normalizeFragment(fragment);
  if (target && !localFile) target.fragment = currentFragment;
  sendDocument('fragment', {fragment: currentFragment || '#'});
}
function updateScriptUI() {
  const rows = [...scriptRecords.values()], blocked = rows.filter((x) => x.blocked).length;
  $('script-count').textContent = `${blocked} blocked`;
  $('script-count').classList.toggle('has-blocked', blocked > 0);
  $('script-details-toggle').disabled = !current;
  $('script-summary').textContent = stats
    ? `${stats.inlineScripts} inline script element(s), ${stats.embeddedScripts} embedded/archived script reference(s). ${blocked} unique blocked script reference(s) detected. HTTPS remote scripts are ${$('remote-scripts').checked ? 'permitted' : 'off'}. Dynamic CSP reports are included when observed. Permitted does not mean successfully loaded; network, CORS or integrity errors may still apply. API requests remain blocked.`
    : 'Open a file to inspect script loading.';
  $('script-list').replaceChildren();
  for (const row of rows.slice(0, 100)) {
    const item = document.createElement('li');
    item.textContent = `${row.blocked ? 'Blocked' : 'Permitted'} — ${row.url} — ${row.reason}`;
    $('script-list').append(item);
  }
  if (rows.length > 100) {
    const item = document.createElement('li'); item.textContent = `Showing the first 100 of ${rows.length} detected references.`; $('script-list').append(item);
  }
}
window.addEventListener('hashchange', () => { if (!localFile) jumpFromURL(location.hash); });
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (!localFile && event.source === parent && event.origin === 'https://drive.google.com' && data.channel === 'DRIVE_INLINE_PREVIEW' && data.nonce === nonce && data.action === 'fragment') {
    jumpFromURL(data.fragment); return;
  }
  if (!session || event.source !== $('document').contentWindow || event.origin !== 'null' || data.channel !== 'DIP_DOCUMENT' || data.id !== session.id) return;
  if (data.type === 'ready' && !session.sent) {
    session.sent = true; clearTimeout(startupTimer);
    sendDocument('render', {html: session.html}); session.html = '';
  } else if (data.type === 'loaded') {
    session.loaded = true;
    sendDocument('zoom', {value: Number($('zoom').value)});
  } else if (data.type === 'fragment' && typeof data.fragment === 'string' && normalizeFragment(data.fragment)) {
    setFragment(data.fragment);
  } else if (data.type === 'missing' && typeof data.fragment === 'string' && normalizeFragment(data.fragment)) {
    $('copy-link').disabled = true; $('link-text').hidden = true;
    navigationStatus(`Message target not found in this file: ${normalizeFragment(data.fragment)}`);
  } else if (data.type === 'escape') {
    parentAction('close');
  } else if (data.type === 'notice' && typeof data.text === 'string') {
    navigationStatus(data.text.slice(0, 500));
  } else if (data.type === 'blocked-script' && typeof data.url === 'string' && data.url.length <= 4096 && /^https?:\/\//i.test(data.url) && scriptRecords.size < 2000) {
    const record = scriptRecords.get(data.url);
    if (!record?.blocked) {
      scriptRecords.set(data.url, {url: data.url, blocked: true, reason: 'Blocked by browser script policy at runtime'});
      updateScriptUI();
    }
  }
  // All other messages, including downloads, script permission changes, file
  // opens, native Drive navigation and storage requests, are ignored.
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); parentAction('close'); }
  if (!event.defaultPrevented && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowUp','ArrowDown'].includes(event.key)) {
    event.preventDefault(); sendDocument('key', {key: event.key});
  }
});
$('copy-link').addEventListener('click', async () => {
  const text = !localFile && target ? driveMessageURL(target, currentFragment) : currentFragment;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    navigationStatus(localFile || !target ? 'Message fragment copied.' : 'Drive message link copied. Opening it at the message needs this extension and file access.');
  } catch {
    $('link-text').value = text; $('link-text').hidden = false;
    $('link-text').focus(); $('link-text').select();
    navigationStatus('Clipboard access was blocked. Copy the selected link with Command+C or Ctrl+C.');
  }
});
$('script-details-toggle').addEventListener('click', () => {
  $('script-details').hidden = !$('script-details').hidden;
  $('script-details-toggle').setAttribute('aria-expanded', String(!$('script-details').hidden));
});
$('remote-scripts').addEventListener('change', () => {
  if (!current) return;
  try {
    render(current);
    navigationStatus(`Preview restarted. HTTPS remote scripts are ${$('remote-scripts').checked ? 'allowed for this preview' : 'blocked'}. This setting resets when another file is opened.`);
  } catch (error) { fail(error); }
});
$('close').addEventListener('click', () => parentAction('close'));
$('native').addEventListener('click', () => parentAction('native'));
$('reload').addEventListener('click', () => loadDrive());
$('native').disabled = !target || parent === window;
$('auto').checked = (await chrome.storage.local.get({autoPreview: true})).autoPreview;
$('auto').addEventListener('change', async () => {
  await chrome.storage.local.set({autoPreview: $('auto').checked});
  navigationStatus($('auto').checked
    ? 'Automatic preview is on for HTML/MHTML files you open in Drive. This does not auto-refresh the file.'
    : 'Automatic preview is off. Drive will use its normal preview. The extension toolbar icon still works.');
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.autoPreview) $('auto').checked = changes.autoPreview.newValue !== false;
});
function showMode(source) {
  if (!current) return;
  $('document').hidden = source; $('source-code').hidden = !source;
  $('rendered').classList.toggle('selected', !source); $('source').classList.toggle('selected', source);
  $('rendered').setAttribute('aria-pressed', String(!source)); $('source').setAttribute('aria-pressed', String(source));
}
$('rendered').addEventListener('click', () => showMode(false));
$('source').addEventListener('click', () => showMode(true));
$('zoom').addEventListener('change', () => sendDocument('zoom', {value: Number($('zoom').value)}));
function clearFrame() {
  clearTimeout(startupTimer); session = null;
  const frame = $('document').cloneNode(false); frame.removeAttribute('src'); frame.removeAttribute('srcdoc');
  $('document').replaceWith(frame);
}
function busy(text) {
  clearFrame(); navigationStatus(); stats = null; scriptRecords.clear();
  $('copy-link').disabled = true; $('link-text').hidden = true; $('remote-scripts').disabled = true;
  $('error').hidden = true; $('notice').hidden = true; $('document').hidden = true; $('source-code').hidden = true;
  $('empty').hidden = false; $('message-title').textContent = text;
  $('message').textContent = 'The original file is processed in this browser. Its remote CSS, fonts and images can make network requests.';
  $('reload').disabled = true; updateScriptUI();
}
function fail(error) {
  clearFrame(); current = null; $('document').hidden = true; $('source-code').hidden = true;
  $('empty').hidden = false; $('message-title').textContent = 'Preview could not be loaded';
  $('message').textContent = 'Reload the extension and Drive tab. When Drive access is blocked, download the original file and use Open local file.';
  $('error').textContent = error.message || String(error); $('error').hidden = false;
  $('reload').disabled = !target; $('remote-scripts').disabled = true; $('copy-link').disabled = true;
}
function render(file) {
  if (file.bytes.length > MAX_BYTES) throw new Error('This file exceeds the 32 MiB preview limit.');
  const archive = readDocument(file.bytes, file.name, file.contentType);
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const preview = makePreview(archive, {
    documentURLs: !localFile && target ? [driveMessageURL(target)] : [],
    allowRemoteScripts: $('remote-scripts').checked,
    bridge: {id, parentOrigin: viewerOrigin, fragment: currentFragment, zoom: Number($('zoom').value)}
  });
  clearFrame(); current = file;
  session = {id, html: preview.html, sent: false, loaded: false};
  stats = preview.stats; scriptRecords = new Map(preview.scripts.map((x) => [x.url, x]));
  $('filename').textContent = file.name; document.title = `${file.name} — Drive Inline Preview`;
  $('source-code').textContent = decodeText(file.bytes, file.contentType, /\.html?$/i.test(file.name));
  const url = new URL('sandbox.html', location.href); url.search = '?render=' + id; url.hash = id;
  $('document').src = url.href;
  $('empty').hidden = true; $('error').hidden = true;
  $('notice').textContent = preview.warnings.join(' '); $('notice').hidden = !preview.warnings.length;
  $('detail').textContent = `${(file.bytes.length / 1024).toFixed(1)} KiB · ${archive.partCount} archive part(s) · Isolated interactive copy; the original is unchanged`;
  $('reload').disabled = !target || localFile; $('remote-scripts').disabled = false;
  updateScriptUI(); showMode(false);
  startupTimer = setTimeout(() => {
    if (session?.id === id && !session.sent) fail(new Error('The isolated document frame did not initialize. Reload the extension and Drive tab; check chrome://extensions for errors.'));
  }, 8000);
}
async function loadDrive() {
  if (!target) return;
  const run = ++sequence;
  if (localFile) $('remote-scripts').checked = false;
  current = null; localFile = false; currentFragment = target.fragment || '';
  busy('Loading from Google Drive');
  try { const file = await downloadFile(target); if (run === sequence) render(file); }
  catch (error) { if (run === sequence) fail(error); }
}
$('local').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  const run = ++sequence; current = null; localFile = true; currentFragment = ''; $('remote-scripts').checked = false;
  busy('Reading local file');
  try {
    if (!SUPPORTED.test(file.name)) throw new Error('Choose a .html, .htm, .mhtml, or .mht file.');
    if (file.size > MAX_BYTES) throw new Error('This file exceeds the 32 MiB preview limit.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (run === sequence) render({bytes, name: file.name, contentType: file.type});
  } catch (error) { if (run === sequence) fail(error); }
  finally { $('file').value = ''; }
});
if (target) loadDrive();
