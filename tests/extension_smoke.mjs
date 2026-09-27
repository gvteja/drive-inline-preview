/** Tests an installed extension, including the real Drive → viewer → sandbox path.
 * HTTP responses are local fixtures. Extension pages, scripts, CSP, messaging,
 * content scripts, and chrome.storage are real. No signed-in profile is used.
 * Install Playwright, or set PLAYWRIGHT_MODULE to its index.mjs file.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.EXTENSION_PATH || fileURLToPath(new URL('..', import.meta.url)));
const cdpInstall = process.env.EXTENSION_INSTALL_METHOD === 'cdp';
const context = await chromium.launchPersistentContext('', {
  ...(process.env.CHROMIUM ? {executablePath: process.env.CHROMIUM} : {channel: 'chromium'}),
  headless: process.env.HEADED !== '1',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: cdpInstall ? ['--enable-unsafe-extension-debugging'] : [
    `--disable-extensions-except=${root}`, `--load-extension=${root}`
  ],
  viewport: {width: 1440, height: 1000}
});
context.setDefaultTimeout(12000);
context.setDefaultNavigationTimeout(15000);
let checks = 0;
function check(condition, label) { assert.ok(condition, label); console.log(`PASS ${++checks}: ${label}`); }
async function poll(read, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  let id;
  if (cdpInstall) {
    const client = await context.browser().newBrowserCDPSession();
    ({id} = await client.send('Extensions.loadUnpacked', {path: root}));
    await client.detach();
  } else {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    id = new URL(worker.url()).host;
  }
  console.log(`Browser ${context.browser().version()}; installed extension ${id}`);
  const origin = `chrome-extension://${id}`;
  const messageID = 'msg-e9858550-be8c-4426-89d2-6ff73f83e813';
  const requests = [], errors = [];
  const fixtures = {
    HTMLtest123456789: {name: 'conversation.html', type: 'text/html'},
    MHTMLtest12345678: {name: 'conversation.mhtml', type: 'multipart/related'}
  };
  for (const file of Object.values(fixtures)) file.bytes = await readFile(path.join(root, 'examples', file.name));
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (url.host === 'drive.usercontent.google.com') {
      const file = fixtures[url.searchParams.get('id')];
      assert.ok(file, 'Only fixture file IDs may be downloaded');
      return route.fulfill({contentType: file.type, headers: {'Content-Disposition': `attachment; filename="${file.name}"`}, body: file.bytes});
    }
    if (url.host === 'drive.google.com') {
      const fileID = /\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
      const title = fixtures[fileID]?.name || 'Fixture folder';
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><title>${title} - Google Drive</title><h1>Local Drive fixture</h1><textarea id="clipboard-probe" aria-label="Test paste target"></textarea>${fileID ? '' : '<div role="row" tabindex="0" data-id="HTMLtest123456789" aria-selected="true"><span>conversation.html</span></div>'}`});
    }
    if (url.href === 'https://assets.preview.test/remote.js') {
      return route.fulfill({contentType: 'text/javascript', body: 'window.remoteRan=true;'});
    }
    return route.abort();
  });
  const page = await context.newPage();
  let topLoads = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) topLoads++;
  });
  page.on('pageerror', error => errors.push(error.message));
  async function viewerFrame() {
    return poll(() => page.frames().find(frame => frame.url().startsWith(origin + '/viewer.html')), 'extension viewer');
  }
  async function documentFrame(viewer, ready = '#ce-prompt-navigation a') {
    await viewer.locator('#document').waitFor({state: 'visible'});
    const frame = await (await viewer.locator('#document').elementHandle()).contentFrame();
    await frame.locator(ready).first().waitFor({timeout: 12000});
    assert.ok(!(await viewer.locator('#error').isVisible()));
    assert.ok(frame.url().startsWith(origin + '/sandbox.html?render='));
    return frame;
  }
  async function local(viewer, file, ready) {
    await viewer.locator('#file').setInputFiles(file);
    return documentFrame(viewer, ready);
  }
  // First use the real content script, downloader, and automatic overlay path.
  await page.goto('https://drive.google.com/file/d/HTMLtest123456789/view?authuser=1&resourcekey=0-test#' + messageID);
  let viewer = await viewerFrame();
  let doc = await documentFrame(viewer);
  check((await doc.locator('#status').innerText()).includes('embedded script is running'), 'Downloaded HTML runs its own embedded script');
  await doc.locator('#' + messageID).evaluate(el => {
    if (!el.hasAttribute('data-dip-current-target')) throw new Error('Initial message fragment was not applied');
  });
  await doc.locator('#ce-prompt-navigation a').nth(2).click();
  await page.waitForURL('**#msg-third');
  check(new URL(page.url()).hash === '#msg-third', 'Original prompt marker updates the Drive fragment');
  await viewer.locator('#copy-link').click();
  await poll(() => viewer.locator('#navigation-status').innerText().then(text => text.startsWith('Drive message link copied.')), 'one-click copy');
  check(!(await viewer.locator('#link-text').isVisible()), 'Copy button succeeds without manual-copy fallback');
  // Paste only the link just copied. No clipboard-read permission is granted.
  await page.locator('#clipboard-probe').focus();
  await page.keyboard.press('ControlOrMeta+V');
  const expectedLink = 'https://drive.google.com/file/d/HTMLtest123456789/view?authuser=1&resourcekey=0-test#msg-third';
  check(await page.locator('#clipboard-probe').inputValue() === expectedLink, 'Actual clipboard contains the Drive link, account, resource key, and message');
  check(await doc.evaluate(() => !document.featurePolicy.allowsFeature('clipboard-write') && !document.featurePolicy.allowsFeature('clipboard-read')), 'Exported file frame denies clipboard access');
  const directURL = page.url(), directLoads = topLoads;
  await page.evaluate(() => { window.drivePageMarker = 'same-document'; });
  await viewer.locator('#native').click();
  await page.locator('[data-drive-inline-preview]').waitFor({state: 'detached'});
  // Wait past the content script's 300 ms mutation scan to catch reopening.
  await page.waitForTimeout(500);
  check(page.url() === directURL && topLoads === directLoads && await page.evaluate(() => window.drivePageMarker === 'same-document'), 'Drive preview preserves the direct URL and document without a reload');
  check(await page.locator('[data-drive-inline-preview]').count() === 0, 'Drive preview does not immediately reopen the overlay');

  await page.goto('https://drive.google.com/file/d/MHTMLtest12345678/view');
  viewer = await viewerFrame();
  doc = await documentFrame(viewer);
  check((await doc.locator('#status').innerText()).includes('embedded script is running'), 'Downloaded MHTML runs its embedded script');
  check(await doc.locator('#ce-prompt-navigation').count() === 1 && await doc.locator('#ce-prompt-navigation a').count() === 3, 'MHTML rebuilds its saved prompt bar once');
  check(!(await viewer.locator('#remote-scripts').isChecked()), 'A new preview resets remote-script consent');
  await doc.locator('#ce-prompt-navigation a').nth(1).click();
  await page.waitForURL('**#' + messageID);
  check(true, 'MHTML prompt marker updates the Drive fragment');

  const isolated = await doc.evaluate(() => {
    const denied = fn => { try { fn(); return false; } catch (error) { return error.name === 'SecurityError'; } };
    return {origin: self.origin, parent: denied(() => parent.document.body), top: denied(() => top.document.body),
      storage: denied(() => localStorage.setItem('dip-test', '1')), api: !!globalThis.chrome?.runtime?.id};
  });
  check(isolated.origin === 'null' && isolated.parent && isolated.top && isolated.storage && !isolated.api,
    'File keeps opaque origin; viewer, Drive DOM, storage, and extension APIs are denied');
  const remoteFile = {name: 'remote.html', mimeType: 'text/html', buffer: Buffer.from(`<!doctype html><p id="ready">Remote policy test</p><script src="https://assets.preview.test/remote.js"></script><script>window.inlineRan=true;</script>`)};
  doc = await local(viewer, remoteFile, '#ready');
  check(await doc.evaluate(() => window.inlineRan === true && !window.remoteRan), 'Embedded script runs with remote scripts off');
  check(!requests.includes('https://assets.preview.test/remote.js'), 'Remote script has no request before consent');
  await viewer.locator('#remote-scripts').check();
  doc = await documentFrame(viewer, '#ready');
  await doc.waitForFunction(() => window.remoteRan === true);
  check(true, 'Remote script runs after explicit consent');
  await viewer.locator('#remote-scripts').uncheck();
  doc = await documentFrame(viewer, '#ready');
  check(await doc.evaluate(() => window.inlineRan === true && !window.remoteRan), 'Turning consent off replaces the document and blocks remote code');
  await viewer.locator('#close').click();

  // The same action must preserve a folder and any native preview beneath it.
  await page.goto('https://drive.google.com/drive/u/1/folders/folder123456789');
  await page.waitForTimeout(350);
  await page.locator('[data-id="HTMLtest123456789"]').dblclick();
  viewer = await viewerFrame();
  await documentFrame(viewer);
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'conversation.html');
    dialog.id = 'native-preview'; dialog.textContent = 'Existing Drive preview'; document.body.append(dialog);
  });
  const folderURL = page.url(), folderLoads = topLoads;
  await viewer.locator('#native').click();
  await page.locator('[data-drive-inline-preview]').waitFor({state: 'detached'});
  await page.waitForTimeout(500);
  check(page.url() === folderURL && topLoads === folderLoads && await page.locator('#native-preview').isVisible(), 'Drive preview reveals the existing native preview and preserves the folder URL');
  check(await page.locator('[data-drive-inline-preview]').count() === 0, 'Native preview stays open after the automatic scan');
  await page.locator('[data-id="HTMLtest123456789"]').dblclick();
  viewer = await viewerFrame();
  await documentFrame(viewer);
  check(true, 'Explicit file open still works after returning to Drive');
  await viewer.locator('#close').click();
  await page.locator('[data-drive-inline-preview]').waitFor({state: 'detached'});
  check(true, 'Close still removes the overlay');

  // Exposing the shell to Drive must not let Drive send render commands.
  await page.goto('https://drive.google.com/drive/u/0/my-drive');
  const renderID = 'a'.repeat(32);
  await page.evaluate(({origin, renderID}) => {
    const frame = document.createElement('iframe'); frame.id = 'direct-sandbox';
    frame.src = `${origin}/sandbox.html#${renderID}`; document.body.append(frame);
  }, {origin, renderID});
  const shell = await (await page.locator('#direct-sandbox').elementHandle()).contentFrame();
  await shell.waitForLoadState();
  await page.evaluate(renderID => {
    document.querySelector('#direct-sandbox').contentWindow.postMessage({channel: 'DIP_DOCUMENT', id: renderID, type: 'render', html: '<p id="forged">FORGED</p>'}, '*');
  }, renderID);
  // Wait one cross-frame message round trip before checking rejection.
  await shell.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  check(await shell.locator('#forged').count() === 0 && (await shell.locator('body').innerText()).includes('Preparing isolated preview'), 'Direct Drive parent cannot render into the exposed sandbox shell');
  check(errors.length === 0, `No uncaught script errors: ${errors.join('; ')}`);
  console.log(`\n${checks} installed-extension checks passed.`);
} finally {
  await context.close();
}
