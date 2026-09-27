# Drive Inline Preview

A Chrome extension for HTML and MHTML previews inside Google Drive. It runs the export’s own JavaScript, including ChatGPT prompt navigation bars. Version 0.3.2. MIT license.

## Install from a fresh clone

```sh
git clone https://github.com/gvteja/drive-inline-preview.git
cd drive-inline-preview
```

There is no build step or runtime dependency. The source files are the extension.

1. Open `chrome://extensions` in Chrome 120 or later.
2. Enable **Developer mode** and select **Load unpacked**.
3. Select this repository folder, which contains `manifest.json`.
4. Refresh the Google Drive tab.

After a code update, click **Reload** for this extension and refresh Drive again.

To package the committed extension files as a ZIP:

```sh
git archive --format=zip --output=drive-inline-preview.zip HEAD manifest.json background.js content.js viewer.html viewer.css viewer.js sandbox.html sandbox.js lib LICENSE
```

Extract the ZIP before using **Load unpacked**. The package contains no tests or development dependencies.

## Use

- Open an `.html`, `.htm`, `.mhtml`, or `.mht` file in Drive. You can also use the extension toolbar button or **Open local file**.
- Use the file’s prompt bar, links, or Alt/Option + Up/Down. **Copy message link** copies the current Drive file and message URL. A local file copies only the message fragment.
- **Allow remote scripts** enables HTTPS scripts for this preview. Changing it restarts the document. Opening another file resets it to off.
- **Drive preview**, **Close**, and Escape reveal the Drive page beneath the overlay without reloading it.
- **Open HTML/MHTML automatically** controls automatic opening. The extension toolbar button still works when this is off.

Use trusted exports. Embedded scripts run by default, and remote images, CSS, and fonts can make network requests. See [SECURITY.md](SECURITY.md) for the security model.

The input limit is 32 MiB. MHTML must contain the code and assets needed by the export. The extension cannot restore missing scripts or find sibling files in Drive. If a download fails, download the original through Drive and use **Open local file**. Relative assets, modules, and code that needs storage or network APIs can remain incompatible.

## Tests

Node.js 22 or later runs the small parser, download, link, and policy suite without installing packages:

```sh
npm test
```

The optional browser test checks the installed extension, HTML/MHTML navigation, copying, return to Drive, and frame isolation:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:extension
```

It uses a temporary profile and local Drive responses. It does not use your signed-in account. The copy test replaces the clipboard with a test link.

For a current Google Chrome build, set `CHROMIUM` to its executable and `EXTENSION_INSTALL_METHOD=cdp`. Set `HEADED=1` to show the test window. If Playwright is installed elsewhere, set `PLAYWRIGHT_MODULE` to its absolute `index.mjs` path.

## Files

| Files | Purpose |
| --- | --- |
| `manifest.json`, `background.js` | Permissions and toolbar action |
| `content.js` | Drive file detection and overlay |
| `viewer.html`, `viewer.css`, `viewer.js` | Viewer controls and downloads |
| `sandbox.html`, `sandbox.js` | Isolated document startup |
| `lib/` | MIME parsing, resource preparation, and message navigation |
| `examples/` | Small HTML/MHTML samples used by the tests |
| `tests/` | Unit checks and one installed-extension test |
