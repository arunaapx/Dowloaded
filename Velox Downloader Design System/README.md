# Velox Downloader — Design System

A design system for **Velox Downloader v2.1**, a desktop video-download utility with a companion browser extension. The product is built for individuals who want to pull videos and audio from YouTube, Facebook, TikTok, Instagram, Twitter/X, Vimeo, Dailymotion, and 1000+ other sites in a polished, glass-morphic Windows-native window — without the ad-laden websites that usually offer this service.

## Products represented

There are **two surfaces** in the product family, and both are documented here:

1. **Desktop app** (`ui_kits/desktop/`) — an Electron application (Chromium + Node) styled to feel native to Windows 11 with its Mica/Acrylic surfaces, custom titlebar, and translucent panels. yt-dlp does the actual downloading; ffmpeg merges streams and converts to MP3. The window is 1100×760 by default and rendered with `backgroundMaterial: 'acrylic'`.
2. **Browser extension** (`ui_kits/extension/`) — a Manifest V3 extension for Chrome/Edge/Brave/Firefox that injects an in-page "Download" pill on top of any `<video>` element, plus a toolbar popup. It speaks to the desktop app via a tiny local bridge at `http://127.0.0.1:47813`.

Both surfaces share one visual language: dark-glass cards, a cyan-to-blue accent gradient, soft outer glow on interactive elements, generous radii, and Segoe UI typography.

## Sources

This design system was derived directly from the application's source code:

- **GitHub repo:** `arunaapx/Dowloaded` (private)
- **Renderer:** `renderer/{index.html, app.js, styles.css}` — the desktop UI
- **Extension:** `extension/{manifest.json, popup.*, content.*, background.js, icons/}`
- **Main process:** `main.js`, `preload.js` — IPC and download orchestration

The repo's `README.md` and `extension/README.md` provided the product copy used to derive the tone-of-voice guidance below.

## Index — files in this system

| File | Purpose |
|---|---|
| `README.md` | This document — overview, content + visual foundations, iconography |
| `SKILL.md` | Designer brief — guardrails, voice, and "when to break rules" guidance for anyone making new Velox screens |
| `colors_and_type.css` | CSS custom properties for all color + type tokens (`--velox-*`) |
| `assets/` | Logos (SVG + PNG at 16/32/48/128) plus the iconography legend |
| `preview/` | Small HTML cards rendered in the Design System tab — type, color, components, etc. |
| `ui_kits/desktop/` | React/JSX recreation of the Electron app, with `index.html` demo |
| `ui_kits/extension/` | React/JSX recreation of the popup + in-page download pill |

---

## CONTENT FUNDAMENTALS

Velox's voice is **utilitarian, second-person, calm**. It is a tool, not a personality. Copy explains what the app is doing and what the user should do next — nothing else. There is no marketing exuberance, no exclamation points, no "Welcome!" greeting, no whimsy.

### Person and pronouns
- Talks to the user as "**you**" (`Only download videos you have the right to download`).
- Speaks about the product in the third person, by name: "**Velox**" or "**the desktop app**" (`Velox app not running`, `Sent to Velox`).
- Avoids "we" or "our" entirely. No team voice.

### Casing
- **Sentence case for prose and labels:** `Paste Video URL`, `Audio bitrate`, `No active downloads. Paste a URL above to start.`
- **Title Case for nav items and tabs:** `New Download`, `Library`, `Browser`, `Search`.
- **ALL CAPS** is reserved for the *one* primary CTA and tightly tracked: `START DOWNLOAD` (700 weight, 0.5px tracking). Don't introduce more all-caps; it dilutes that one button.
- **Tiny eyebrow labels** in advanced sections are uppercase with 0.08em tracking (`FORMAT & CODEC`, `AUDIO`).

### Tone examples to imitate

| Situation | Velox says |
|---|---|
| Empty state | `No active downloads. Paste a URL above to start.` |
| Empty library | `No completed downloads yet.` |
| Coming-soon tab | `Built-in browser is coming in a future update.` |
| Connected | `Connected: Velox Downloader v2.1` |
| Disconnected | `Velox app not running. Open the desktop app.` |
| Failure | `Could not reach app.` / `Failed` |
| Success (transient) | `Sent to Velox · MP3 · 192 kbps` |
| Activity log | `Merging audio + video…` / `Extracting audio…` / `→ Big Buck Bunny.mp4` |

Patterns to notice:
- **Three dots** (`…`, never `...`) on transient progress states.
- **`Connected: <name> v<version>`** for status — name + version comma-free, colon-separated.
- **Bullet separator** is the middle dot ` · ` (used in toasts, library subtitles, log meta). Never `|`.
- **Arrow `→`** marks "now downloading this file" in the log. Reserved for state transitions, not decoration.
- **Failures are short.** Two words is fine. Don't apologize, don't blame, don't suggest remedies inline — the warning banner does that.

### Microcopy do/don't

| Do | Don't |
|---|---|
| `Paste Video URL` | `Enter the URL of the video you'd like to download` |
| `Start Download` | `Get my video now!` |
| `Open Folder` | `Reveal in Explorer` (too OS-specific in shared copy) |
| `Sent to Velox` | `Successfully queued your download` |
| Numbers prefixed: `1080p`, `320 kbps`, `4K` | `Full HD`, `High quality` |

### Emoji & symbols

Sparingly. Today there are exactly **three** emoji glyphs in the codebase, all in the **extension's in-page menu** to differentiate video from audio rows:
- 🎬 video row
- 🎵 audio row
- 📂 "open folder" affordance on the desktop save-to row

Treat these as **icons-by-other-means**, not as expression. Outside of those three slots, prefer SVG iconography (see ICONOGRAPHY below). Never use emoji in headings, in error states, or in marketing copy.

### Legal / responsibility note

The product is explicit about user responsibility: `Only download videos you have the right to download. Respect each platform's Terms of Service and the original creator's copyright.` Echo this calm, non-preachy framing if you add any legal copy.

---

## VISUAL FOUNDATIONS

### The big idea

A **dark, glass-morphic** desktop interface that leans into Windows 11's Acrylic material. Cards float on a blurred surface; an electric cyan→blue gradient marks anything interactive and meaningful. Everything else is grayscale.

### Color

**Accent gradient is the centerpiece.** Use `linear-gradient(135deg, #6cc4ff → #4ea8ff)` for the one primary button, the progress bar fill, the active state of segmented switches, and the logo's outer glow. There is **no other gradient** anywhere in the UI except the logo (`#4ea8ff → #a78bfa`, blue→purple), which appears once and gets the `0 4px 12px rgba(78,168,255,0.40)` shadow underneath.

The full palette lives in `colors_and_type.css`:

- **Surfaces** are translucent and rely on backdrop-blur: `rgba(28,32,44,0.72)` for cards, `rgba(20,24,36,0.85)` for inputs.
- **Text** descends through three steps: `#e6ebf3 → #98a2b3 → #6b7280`. There is no fourth step.
- **Semantic colors** appear only as state, never as decoration: `#6ee7a3` success, `#ff7a8a` danger, `#fcd34d` warning. They tint borders + text of small status banners and the progress-bar fill on completion/error states.

A light mode exists (`body.light`) with white-glass cards over a near-white app shell. It is a one-line toggle in the titlebar; both modes must look first-class.

### Typography

- **Family:** Segoe UI first, then `system-ui, -apple-system, BlinkMacSystemFont, Helvetica Neue, Arial`. Mono is Consolas. No webfonts ship with the product.
- **Scale:** 22 / 18 / 15 / 14 / 13 / 12 / 11. Sizes 14 and 13 carry the most weight (body and pill labels).
- **Weight ladder:** 400 body, 500 medium for labels, 600 semibold for titles + active pills, 700 bold for the primary CTA, 800 reserved for the popup logo glyph "V".
- **Tracking:** Default tracking everywhere except the primary CTA (+0.5px) and eyebrow uppercase labels (+0.08em).

### Layout & spacing

- The Electron window has a **32px hidden titlebar** with a draggable region; the titlebar carries logo, nav, theme toggle.
- The main content area pads `22px 26px 30px`.
- Inside a card, content stacks with **16px gaps**; rows inside (`url-row`, `options-row`, `folder-row`) use 8–14px gaps.
- The advanced panel is separated by a **1px dashed border** at top with 16px padding — the only dashed line in the system, reserved for "this section is optional / extended."
- Cards stretch full-width inside the main column. The active downloads grid is `repeat(auto-fill, minmax(380px, 1fr))`.

### Backgrounds, transparency, blur

- Window root is `transparent` — the OS Acrylic shows through. We never paint a solid background on `<body>`.
- Every card uses `backdrop-filter: blur(20–24px)`. The in-page extension menu uses `blur(20px)` on a near-opaque tile.
- **Imagery** in the product is purely user-supplied (video thumbnails inside job cards and library rows). Thumbnails fall back to a `linear-gradient(135deg, #2a3145, #1a1f30)` placeholder with a centered film-strip icon. There are no marketing photos, no illustrations, no patterns.

### Animation & motion

Tight, fast, intentional. No bounces, no spring physics, no parallax.

- **Hover / focus transitions:** 150ms on all interactive elements (`transition: all 0.15s`). Properties affected: background, color, border, transform, box-shadow.
- **The accent button lifts 1px on hover** (`translateY(-1px)`) and **scales to 0.98** on press. Only the primary button does this — pills and ghost buttons stay flat.
- **The in-page extension pill** fades + drops 4px on enter (180ms), and its menu slides in over 140ms with `velox-menu-in` keyframes.
- **Progress-bar fill** transitions width at 250ms with a soft accent-colored shadow.
- **The dropdown menu caret** rotates 180° in 180ms when its parent gets `.velox-open`.
- **Spinner:** linear 0.8s rotation, stroke-dasharray `14 36` (a partial ring, not a full circle).
- **Toast** fades + slides up 20px in 220ms.

There are **no entrance animations** when the desktop window opens. The UI is just there.

### Hover & press states

- **Nav button hover:** `background: rgba(255,255,255,0.06); color: var(--velox-text)`. Active state adds an inset 1px ring (`box-shadow: inset 0 0 0 1px var(--velox-border-strong)`).
- **Pill hover (inactive):** text moves from dim → primary, border moves from `--velox-border` → `--velox-border-strong`.
- **Pill active:** background `rgba(108,196,255,0.18)`, text `--velox-accent`, border `rgba(108,196,255,0.40)`. No gradient — flat tint only.
- **Primary button press:** `transform: scale(0.98)`. Drops the lift first, then scales.
- **Icon button hover:** color + border both turn cyan (`var(--velox-accent)`); background unchanged.
- **Control buttons inside job cards:** hover = `background: rgba(255,255,255,0.06)`. Danger variant additionally turns text `--velox-danger` on hover.

### Borders, corners, radii

- Hairline borders are **1px** in `rgba(255,255,255,0.08)` (dark) / `rgba(0,0,0,0.08)` (light). Stronger variant is `0.14`.
- Radii are stepped: **4 (badges) → 6 (mono pills) → 8 (pills, nav) → 10 (inputs, buttons) → 14 (cards) → 999 (segmented switch, toggle)**.
- The logo tile is **8px**; the popup logo glyph tile is also 8px at 34px square.
- We never use *only* a left-border colored stripe to indicate state. The active pill paints the whole tile.

### Shadows & glow

There is a layered system:

| Token | Shadow | Used on |
|---|---|---|
| `--velox-shadow-card` | `0 6px 24px rgba(0,0,0,0.18)` | Cards, jobs |
| `--velox-shadow-menu` | `0 16px 40px rgba(0,0,0,0.60)` | Dropdown menu in extension |
| `--velox-shadow-pill` | `0 8px 22px rgba(0,0,0,0.55)` | Floating in-page download pill |
| `--velox-shadow-btn` | `0 4px 16px rgba(108,196,255,0.35)` | Primary CTA at rest |
| `--velox-shadow-logo` | `0 4px 12px rgba(78,168,255,0.40)` | Logo tile and popup logo |
| `--velox-accent-glow` | `0 0 20px rgba(108,196,255,0.35)` | Range thumbs, active segmented buttons, progress-bar fill |

The in-page pill stacks **three shadows at once** — drop, inset highlight, and outer glow — which gives it the "wedged onto the page" look. Reuse that recipe when you need an element to *feel* injected.

### Transparency & blur

Transparency is **structural**, not decorative. The OS Acrylic is the second layer of every screen; cards must therefore use rgba surfaces, never solid colors. Inputs are the most opaque (`0.85`) so text remains legible; cards sit at `0.72`; pill backgrounds drop to `0.05`.

### Layout rules / fixed elements

- **Titlebar** is fixed at the top, height ~52px, drag-region except for nav buttons and theme toggle (which are `-webkit-app-region: no-drag`).
- **Window controls** (min/max/close) are drawn by the OS via `titleBarOverlay`. Reserve ~130px on the right of the titlebar.
- **Log details** sit at the bottom of the New Download pane as a `<details>`; collapsed by default.
- **The browser extension's pill** floats inside `<video>` bounding boxes — top-right with 12px inset. Re-positions on scroll/resize via requestAnimationFrame. Hidden when the video is smaller than 240×150 or off-screen.

### Imagery color vibe

Cool, dark, slightly desaturated. Job thumbnails come from arbitrary video sources, so the product doesn't curate imagery — but its *placeholders* are gunmetal blue (`#2a3145 → #1a1f30`). If you add brand imagery (screenshots, hero shots), keep them cool, low-saturation, with deep navy shadows. Avoid warm/orange palettes; they fight the cyan accent.

---

## ICONOGRAPHY

Velox draws all of its glyphs as **inline SVGs in the source**. There is no icon font, no Lucide/Heroicons import, no PNG sprite. Strokes are crisp, stroke-width is consistently **1.6**, caps and joins are **round**, the viewbox is uniformly `0 0 24 24`.

### Inventory found in the codebase

| Glyph | Where it appears | Path summary |
|---|---|---|
| Hex prism + caret (the logo mark) | Titlebar logo tile, extension icon | Stacked hexagon outline with a down-chevron inside |
| Folder | Library tab, "Open Folder" controls, `📂` open-folder shortcut | Two-segment folder with a tab |
| Globe | Browser tab | Circle + meridians |
| Search | Search tab | Circle + handle |
| Gear / sliders | Settings nav button | Standard cogwheel |
| Paste | Clipboard icon button | Clipboard with tab |
| Play | Library thumbnail placeholder | Rectangle + filled triangle |
| Pause / Play | Job controls | Two bars / triangle |
| Cross | Cancel button | Two diagonals |
| Down arrow | In-page extension pill | Vertical arrow + tray |
| Spinner | In-page pill loading | Dashed circle (`14 36` dasharray) |
| Check | In-page pill success | Tick |
| Bang | In-page pill error | Vertical with dot |

All of these are **stroke-based** except the pause/play bars and the placeholder play-triangle (filled). When you need a new icon not in the inventory:

1. **First** copy from the codebase if a close match exists (in `renderer/index.html` or `extension/content.js`).
2. **Otherwise** substitute from **Lucide** (https://lucide.dev) at `stroke-width: 1.6`, 24px viewbox, rounded caps. Lucide is the closest CDN match to Velox's existing line work. *Flag the substitution to the user when you do this.*
3. Never reach for Material Symbols, FontAwesome, or emoji as a replacement.

Two raster assets ship for the OS shell (taskbar / extension toolbar) and live in `assets/`:

- `velox-logo.svg` — vector source, gradient #6cc4ff→#a78bfa, white "V"-arrow glyph
- `velox-logo-16.png` / `-32.png` / `-48.png` / `-128.png` — PNG raster at extension manifest sizes

### Logo wordmark

There is no proper wordmark — only the **logo tile + "Velox Downloader" set in 15px/600 Segoe UI** beside it, with a dim `v2.1` version chip. Treat that pairing as the lockup. The popup uses just the "V" glyph (Segoe UI 800, dark text on gradient tile).

---

## How to apply this system

1. **Pull tokens:** `<link rel="stylesheet" href="colors_and_type.css">` and add `class="velox"` to your root for the default sans family + dark colors.
2. **Compose with kit components:** import from `ui_kits/desktop/` (JSX) for primary buttons, pills, switches, cards, job tiles, titlebar, segmented switches.
3. **Match the voice:** check the CONTENT FUNDAMENTALS table before writing any new copy.
4. **Pick the right icon source:** SVG inline, stroke-width 1.6 — or Lucide as the documented fallback.

---

## Caveats

- **Fonts** — The product ships no webfonts; it relies on system Segoe UI on Windows. On non-Windows targets, the stack falls back to `system-ui` / `-apple-system`. If you need exact rendering off-Windows, the nearest Google Fonts substitute is **Inter** (heavier 14px-default sibling); apply it via `--velox-font-sans`.
- **Logo lockup** is informal — only an icon mark exists in the codebase. A proper wordmark would be a useful next deliverable.
- **No public color names** — the codebase uses CSS variables named for role only (`--accent`, `--text-dim`); there are no marketing names for swatches. The tokens here mirror that.
