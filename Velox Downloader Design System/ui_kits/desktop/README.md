# Desktop UI Kit — Velox Downloader

Recreation of the Electron renderer (`renderer/index.html` + `app.js` + `styles.css`) as composable React components. The kit covers the chrome (titlebar, nav, theme toggle) and the New Download flow (URL field, mode switch, quality pills, primary CTA, advanced panel, active jobs, library).

**Source of truth:** the in-project codebase under `/renderer/`. Visuals are pixel-faithful; behavior is mock (clicks update local state, no IPC).

Components live in `/ui_kits/desktop/`:

| File | Provides |
|---|---|
| `Titlebar.jsx` | Drag region, logo lockup, primary nav, theme toggle |
| `NewDownload.jsx` | The big download card — URL row, mode group, quality pills, CTA, folder row |
| `JobCard.jsx` | Active-download tile with thumbnail, progress, controls |
| `LibraryRow.jsx` | Completed-download row |
| `Pieces.jsx` | Primary button, ghost button, icon button, pill, segmented switch, switch |
| `App.jsx` | Wires it all into a fake Electron window |

`index.html` mounts everything and includes a sham titlebar window-control area so the screenshot reads as a real desktop window.
