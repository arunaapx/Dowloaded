# SKILL — Designing for Velox Downloader

You are designing for **Velox Downloader**, a desktop YouTube/video downloader (Electron app + browser companion extension). Use these rules whenever you touch any artifact for this brand.

## The product in one paragraph
A small, focused app for grabbing videos & audio from any pasteable URL. The user paste-and-clicks; the app handles the rest. Power is hidden behind an Advanced toggle. The matching browser extension adds a one-click Download pill on supported video pages. Both surfaces are quiet utilities — they should feel snappy and out of the way, not branded or flashy.

## Mandatory reads before touching visuals
1. `/colors_and_type.css` — the only source of truth for color tokens, type, radii, shadows, fonts.
2. `/preview/` — every primitive (buttons, pills, switch, job card, …) rendered in isolation. Match these visuals; do not reinvent.
3. `/ui_kits/desktop/` — assembled desktop app. Read `App.jsx` to see how primitives compose.
4. `/ui_kits/extension/` — in-page pill + popup. Note that the extension uses **system fonts** (-apple-system / Segoe UI), not Outfit/JetBrains Mono, so it inherits the host browser feel.

## Aesthetic guardrails (do not break these)
- **Dark surface by default** (`#0c1220` base, translucent glass cards over a faint blue + violet radial wash). Light theme exists and is enabled by the titlebar Switch.
- **One accent.** `--velox-accent` (#6CC4FF) → `--velox-accent-2` (#4EA8FF) gradient on the **primary** CTA, the active pill, the active switch, focus rings, and progress bars. Purple `#A78BFA` is a rare secondary; reach for it only when you genuinely need a second emphasis tier. Never introduce a third accent.
- **State colors stay narrow:** `--velox-success` green for "Done", `--velox-warning` amber for "Paused" / binary warning, `--velox-danger` red for "Failed" / Cancel hover. That's the entire semantic palette.
- **Typography:** Segoe UI (system stack — no webfonts) for everything UI; Consolas / JetBrains Mono for filesystem paths and `<code>`. Eyebrow / section labels are 12px / 600 / `.08em` / uppercase in `--velox-text-faint`. The primary CTA has 0.5px tracking; everything else is default.
- **Radii:** 8 for chips & pills, 10 for buttons/inputs/banners, 14 for cards. Never go above 14 except `999` for the segmented switch.
- **Shadows:** Use the four CSS variables (`--velox-shadow-card`, `--velox-shadow-btn-rest`, `--velox-shadow-btn-hover`, `--velox-shadow-logo`). Don't invent new drop shadows.
- **Backdrop blur is part of the brand.** Cards, nav, popup, in-page pill — they all sit on `backdrop-filter: blur(20px) saturate(140%)` over the radial-tinted body. Don't replace with solid fills.
- **Glow, sparingly.** The primary CTA, the in-page pill, and the gradient switch get an outer `box-shadow` glow with ~35% accent opacity. Other elements stay matte.

## Compositional rules
- Layout in **flex / grid with `gap`** — never margin-spaced inline siblings. The desktop card row, quality pill group, and active-jobs grid all use `gap`.
- **Active downloads grid:** `repeat(auto-fill, minmax(360px, 1fr))` at gap 14.
- **Job card** = thumbnail (92×64, badge top-left) + info column (title row + progress bar + meta row) + controls strip (border-top divider, ghost buttons).
- **Job state ↔ visual:**
  - downloading → blue gradient bar, "%" state, Pause + Cancel buttons
  - paused → amber state label, Resume + Cancel
  - done → green gradient bar at 100%, "Done", Open Folder only
  - error → red bar, "Failed", Cancel only
- **Quality pills** show in the order 4K → 1440p → 1080p → 720p → 480p → 360p; Normal mode shows only `4K · 1080p · 720p`, Advanced unlocks the rest. Audio mode shows `320 · 192 · 128 kbps`.
- **The binary-missing warning** is a one-line amber banner directly above the download card with the missing binary as `<code>` and the install path as `<code>`. Don't redesign as a modal.

## Copy voice
Terse, factual, second-person where needed. Examples to imitate:
- "Paste Video URL" (input label)
- "START DOWNLOAD" (CTA, uppercase, 0.5px tracking)
- "ffmpeg not found. Required for 1080p+ and MP3."
- "Sent to Velox · MP3 · 192 kbps" (extension toast)
Avoid marketing words ("blazing", "powerful", "seamless"), avoid emoji except where the extension already uses 🎬 / 🎵 in the in-page menu (those are kept because the extension is system-font and can't pull in icon fonts).

## Iconography
Inline SVG, 24×24 viewBox, 1.6 stroke width, `currentColor`, rounded line caps & joins. See `/preview/iconography.html`. Don't switch to filled icons or thinner strokes. Logo is the box-with-chevron mark in a `#6CC4FF→#4EA8FF` rounded tile.

## When you are asked to add a new surface
- Settings page → use the existing card pattern, group rows with the "Section header + section title" pattern from `NewDownload.jsx`. Each row: label + hint + control on the right (mirror the popup's `auto-open` row).
- Onboarding / empty states → use the dashed-border `.placeholder` style from the desktop kit; one-line headline + one-line subhead in `--velox-text-dim`. Don't add hero illustrations.
- Errors → toast (top-right, 10s timeout) for soft failures; the amber `.warning` banner for blocking states (missing binary, no disk space).

## When asked for variations
The default is faithful to the existing visual system. Before diverging, ask: is the user requesting a *brand refresh* (then explore freely) or *new screens in the same product* (then stay on system). On the same product, variations should differ in **layout / density / interaction**, not in color or type.

## Things that are off-limits
- New accent colors / extra gradients
- Skeumorphic textures, photographic backgrounds
- Decorative iconography next to text labels (the in-page menu's 🎬 / 🎵 is the exception, not the rule)
- Inter, Roboto, system-ui as the primary UI font (those are reserved for the extension where the host browser owns the typography)
- Tall hero areas / "above the fold" layouts — the desktop app is a tool, not a website
