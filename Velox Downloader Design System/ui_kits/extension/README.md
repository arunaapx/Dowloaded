# Browser Extension UI Kit — Velox Companion

Recreation of the MV3 content-script + popup pair from `extension/`. Two surfaces:

1. **In-page pill** (`InPagePill.jsx`) — injected onto YouTube/TikTok/etc. pages by `content.js`. A floating "Download" button that opens a quality menu. Talks to the desktop app via `localhost:7717`.
2. **Popup** (`Popup.jsx`) — toolbar popup with connection status, default quality picker, and link to open the desktop app.

`index.html` shows them side-by-side over a fake "video page" backdrop, so the screenshot reads as "this is what users see in the wild."

All visuals use system fonts (`-apple-system, Segoe UI`) to match how the extension actually renders in a browser — it shouldn't adopt the host site's typography.
