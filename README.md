# Video Downloader

Desktop app for downloading videos from YouTube, Facebook, TikTok, Instagram, and 1000+ other sites. Built with Electron + yt-dlp.

## Features

- Single & batch download (paste multiple URLs, one per line)
- Quality selection: 360p → 4K (2160p)
- MP3 audio-only extraction
- Full playlist download
- Progress bars, speed, ETA
- Cancellable downloads
- License profile with expiry day count
- Admin-controlled license expiry, block/unblock, revoke, and device reset

## Setup

### 1. Install Node dependencies

```powershell
npm install
```

### 2. Add the binaries

Download these and place them in the `bin/` folder:

- **yt-dlp.exe** — https://github.com/yt-dlp/yt-dlp/releases/latest (the `yt-dlp.exe` asset)
- **ffmpeg.exe** and **ffprobe.exe** — https://www.gyan.dev/ffmpeg/builds/ (extract both from the release-essentials zip `bin/` folder)

ffmpeg and ffprobe are required for 1080p+ downloads, audio extraction, merging,
remuxing, and compatibility conversion to MP4.

### 3. Run

```powershell
npm start
```

The app license screen talks to `http://localhost:4000` by default. Start the
license server before activating local test keys:

```powershell
cd server
npm install
npm start
```

For a hosted license server, set `LICENSE_SERVER_URL` when launching the app, or
change the fallback URL in `main.js` before building the `.exe`.

### 4. Build a portable .exe (optional)

```powershell
npm run build
```

Output goes to `dist/`.

## How it works

- **Electron** provides the GUI window (Chromium + Node.js).
- **yt-dlp** (external binary) does the actual downloading. It supports YouTube, Facebook, TikTok, Instagram, Twitter/X, Vimeo, Dailymotion, and 1000+ sites.
- **ffmpeg** (external binary) merges separate video/audio streams (YouTube serves them separately above 720p) and converts to MP3.

The app spawns `yt-dlp.exe` as a child process and parses its progress output line by line.

## Legal note

Only download videos you have the right to download. Respect each platform's Terms of Service and the original creator's copyright.
