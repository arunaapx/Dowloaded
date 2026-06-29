# Velox Downloader — Web App (test guide)

Server-side video downloader served as an installable PWA. Same `yt-dlp` /
`ffmpeg` engine as the desktop app (`core/downloader.js`), but the download runs
on the server and the finished file is sent to the browser.

## Run it locally (test)

From the project root:

```powershell
npm install            # once, installs Electron deps
cd web
npm install            # once, installs the web server deps
npm start
```

Or from the project root in one line:

```powershell
npm run web
```

When it starts you'll see something like:

```
  On this PC:        http://localhost:8080
  On your phone/LAN:  http://192.168.1.x:8080
```

- **On your PC** — open `http://localhost:8099`. Full PWA works here (install +
  download), because `localhost` counts as a secure context.
- **On your phone** — connect to the **same Wi-Fi**, open the
  `http://192.168.1.x:8099` URL shown in the console. Downloads work. App
  *install* and offline need HTTPS, which arrives with the VPS deploy step.

The binaries are picked up from `../bin` automatically. To point elsewhere set
`VELOX_BIN_DIR`.

## How to test

1. Paste a video link (YouTube / TikTok / a direct `.mp4`, etc.).
2. Pick **Video** + a quality, or **Audio (MP3)**.
3. Press **Download** — watch the live progress bar, then the file saves.

> YouTube often blocks server IPs with a bot check. On your home PC it usually
> works; on a VPS you may need cookies or a proxy. Direct `.mp4` links and most
> other sites work without that.

## Settings (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8080` | HTTP port |
| `VELOX_MAX_CONCURRENT` | `2` | how many downloads run at once |
| `VELOX_JOB_TTL_MIN` | `60` | minutes a finished file stays on disk |
| `VELOX_TMP_DIR` | `web/tmp` | where downloads are staged |
| `VELOX_BIN_DIR` | `../bin` | folder holding yt-dlp / ffmpeg |

## Automated browser test

```powershell
cd web
npm start                 # in one terminal
node test/pwa.test.js     # in another — drives a headless browser end to end
```
