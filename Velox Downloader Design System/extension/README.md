# Velox Downloader — Browser Extension

Sends videos from your browser to the Velox Downloader desktop app via a small local bridge (`http://127.0.0.1:47813`).

## Install (Chrome / Edge / Brave)

1. Make sure the **Velox Downloader desktop app is running**.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select this `extension/` folder.
6. Pin the extension to the toolbar (puzzle icon → pin Velox Downloader).

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**
3. Select `extension/manifest.json`.
4. Note: Firefox unloads temporary add-ons when you close the browser. For permanent install, the extension must be signed.

## Usage

**Right-click context menu** (works on any page):
- *Download this page with Velox* — uses the current page URL
- *Download link with Velox* — when right-clicking a link
- *Download video/audio with Velox* — on `<video>`/`<audio>` elements
- *Download as MP3* — extracts audio only

**Toolbar popup** (click the V icon):
- Pick video quality / audio bitrate
- *Download this page* / *As MP3* buttons
- Status indicator shows whether the desktop app is running

When you trigger a download, the desktop app pops to front and the URL appears in the New Download tab with the chosen quality, then auto-starts.

## Troubleshooting

- **"Velox app not running"** in popup → launch the desktop app first (`npm start` from the project folder).
- **Right-click menu missing** → right-click the extension in `chrome://extensions` → reload.
- **Nothing happens after clicking Download** → check the desktop app log (Show log section at bottom of app window) for errors.
- **Port conflict** → another app is using port 47813. Edit `BRIDGE_PORT` in `main.js` and `BRIDGE` in `extension/background.js` + `popup.js` to a free port.

## Security

- The bridge only listens on `127.0.0.1` (your machine, not the network).
- Requests are accepted only if the `Origin` header starts with `chrome-extension://`, `moz-extension://`, `edge-extension://`, or `safari-web-extension://`. Web pages cannot reach the bridge.
- No authentication tokens — anyone with a browser extension on your machine could send URLs. This is acceptable for local-only use; if you want stronger isolation, add a token handshake.
