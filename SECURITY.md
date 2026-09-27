# Security model

Use this extension for HTML and MHTML files you trust. It runs embedded JavaScript so the export’s own controls can work. Isolation limits access to the browser and Drive; it does not make hostile content safe or stop all data from leaving the document.

## Three separate contexts

1. **Drive content script:** Runs only on `drive.google.com`. It detects the selected file, creates the overlay, and handles close and message-fragment updates.
2. **Extension viewer:** Downloads the selected file and owns the controls. Its Content Security Policy (CSP) permits only packaged extension scripts. Exported code does not run here.
3. **Document sandbox:** Runs the prepared export in `sandbox.html`. Both the manifest and iframe apply `sandbox allow-scripts`, without `allow-same-origin`. Chrome gives the document an opaque origin, separate from the viewer and Drive.

The document cannot access the viewer DOM, Drive DOM, extension APIs, or origin storage. Its iframe explicitly denies clipboard read and write. Only the viewer frame permits clipboard writes for its Copy button.

`viewer.html` and `sandbox.html` are web-accessible only from Drive. Both entries are required for the nested frame to load. A sandbox placed directly in a Drive page cannot accept render commands from that page: its startup code requires the extension parent origin.

## Script and network policy

| Capability in the export | Policy |
| --- | --- |
| Inline scripts, handlers, supported archived scripts | Allowed |
| HTTPS images, CSS, and fonts | Allowed by default |
| HTTPS scripts | Allowed only after **Allow remote scripts** is selected |
| HTTP assets and scripts | Blocked |
| Fetch, XHR, WebSocket, workers, and `eval` | Blocked |
| Forms, popups, top navigation, downloads, and external frames | Blocked |

The manifest CSP sets the maximum sandbox permissions. A policy inserted into the prepared document further blocks remote scripts when consent is off. Changing consent replaces the iframe, so the old document is destroyed. Consent resets when another file or preview is opened.

Preparation removes saved frames, active objects, and navigation metadata. It preserves supported scripts and handlers. This is a compatibility step, not a sanitizer. Scripts can create inline child frames, but those frames inherit the sandbox and applicable CSP restrictions.

## Messages and downloads

Messages must match the expected sender window, origin, and render ID. The startup script accepts one render from its extension parent. Later messages handle fragments, zoom, keyboard input, close, and diagnostics. There is no document command for arbitrary downloads, storage writes, clipboard access, or changing script consent.

The render ID is not a secret from file code. A document can alter its own controls and diagnostic reports. The blocked-script count is a display aid, not a security decision.

The viewer downloads from the two permitted Google hosts. It checks the file ID, returned filename, response host, and size. It rejects unverified download pages. Limits cover input size (32 MiB), MIME part count and nesting, decoded archive size, and prepared output size. They do not limit remote asset size or script execution time.

## Permissions and retained data

- `storage` saves only the automatic-opening setting.
- Host access is limited to `drive.google.com` and `drive.usercontent.google.com`. These permissions cover the sites, not only one file.
- File bytes and per-preview script consent stay in page memory. The extension does not save conversation content or send it to a conversion service.
- The extension has no telemetry, remote extension code, or runtime dependencies. Browser and operating-system caches can still retain data.

## Limits

An allowed image, CSS, font, or script URL can send data to its server. A document script can read the displayed conversation and send information through an allowed asset request, even when fetch is blocked and remote scripts are off. Referrer restrictions do not make these requests anonymous or necessarily free of cookies.

Disabling remote scripts cannot undo earlier requests. Source view does not stop the active document. Isolation does not prevent misleading content, excessive CPU or memory use, or browser vulnerabilities.

Tests cover the installed extension with local Drive responses. They do not prove compatibility with every export, signed-in Drive behavior, or resistance to every hostile document. This project has not had a full independent security audit.
