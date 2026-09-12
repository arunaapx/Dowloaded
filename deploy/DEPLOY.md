# Velox — VPS deployment (license + extraction server)

This is the server the **Windows thin client** talks to. It validates licenses
and does the yt-dlp extraction; clients download the bytes themselves.

Target: a small Ubuntu 22.04/24.04 VPS (1–2 vCPU, 2 GB RAM is plenty to start —
the server only extracts, it doesn't move video bytes).

---

## 1. System packages

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ffmpeg (for any server-side fallback) + tools
sudo apt install -y ffmpeg nginx git

# yt-dlp — the extraction engine (keep it updated; sites change often)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
     -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version          # confirm it runs

# PM2 process manager
sudo npm install -g pm2
```

> The core resolves binaries from `PATH` on Linux, so `/usr/local/bin/yt-dlp`
> and the apt `ffmpeg` are picked up automatically. (Override with
> `VELOX_BIN_DIR` if you bundle your own.)

---

## 2. Get the code + install

```bash
cd /opt
sudo git clone <your-repo-url> velox
sudo chown -R $USER:$USER velox
cd velox/server
npm install --omit=dev
```

---

## 3. Configure

```bash
cp .env.example .env
nano .env
```

Set at least:

- `ADMIN_PASS` — a strong admin password (the panel login).
- `NODE_ENV=production` — enables Secure cookies.
- `JWT_SECRET` — optional; if blank one is generated and saved to `data/.jwt-secret`.
- Keep `LICENSE_DEV_BYPASS` **unset / 0**. Setting it disables the license check.
- Tune `VELOX_DAILY_CAP`, `VELOX_IP_BLOCK` to taste.

---

## 4. Run with PM2

```bash
cd /opt/velox
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints, to start on reboot
pm2 logs velox-license
```

(If you only ship the Windows app, delete the `velox-web` block from
`deploy/ecosystem.config.js` first.)

Check it's up locally:

```bash
curl http://127.0.0.1:4000/healthz      # {"ok":true,...}
```

---

## 5. Domain + nginx + HTTPS

Point your domain's DNS **A record** at the VPS IP first. Then:

```bash
sudo cp /opt/velox/deploy/nginx-velox.conf /etc/nginx/sites-available/velox
sudo sed -i 's/your-domain.com/REALDOMAIN/' /etc/nginx/sites-available/velox
sudo ln -s /etc/nginx/sites-available/velox /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# TLS certificate (free, auto-renews)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d REALDOMAIN
```

Verify from anywhere: `https://REALDOMAIN/healthz`.

---

## 6. Point the Windows app at it

Build the app with the production server URL, or launch with:

```
LICENSE_SERVER_URL=https://REALDOMAIN
```

(See `LICENSE_SERVER_URL` in `main.js`.) Then: open the app → activate a key →
download. Extraction happens on the VPS; bytes download on the user's PC.

---

## 7. Create license keys

Open `https://REALDOMAIN/admin`, log in with `ADMIN_USER` / `ADMIN_PASS`, and
create keys (set days or lifetime). The events feed shows `extract`, `resolve`,
and any `usage-anomaly` / `usage-block` activity.

## 8. Shipping an app update

The desktop app checks `https://veloxdownloader.prolanka.online/updates/latest.yml`
on launch and every six hours after that (`publish` in `package.json`). If a newer
version is listed it downloads in the background and the status bar offers a
restart. Nothing is installed behind the user's back, and the licence server is
not in this path — an update still lands if that host is busy.

One-time server setup:

```bash
sudo mkdir -p /opt/velox/updates
sudo cp deploy/nginx-veloxdownloader.conf /etc/nginx/sites-available/veloxdownloader
sudo nginx -t && sudo systemctl reload nginx
```

To cut a release, one command does the whole thing:

```bash
npm run release              # 2.1.1 -> 2.1.2
npm run release -- minor     # 2.1.1 -> 2.2.0
npm run release -- 3.0.0     # exactly that
npm run release -- --dry-run # show what it would do, change nothing
```

It bumps the version, builds, refuses to ship a build that is missing anything
the app needs to boot, uploads the installer, then reads the feed back over
HTTPS to prove clients can actually see the new version. The installer goes up
before `latest.yml` does, so nobody ever sees a release pointing at a file that
is still uploading. It also refreshes the installer the website hands to new
buyers.

The first run writes `release.config.json` and stops so you can check the server
details. That file is gitignored — your host stays off GitHub. Key-based SSH has
to work without a password prompt:

```bash
ssh-keygen -t ed25519
ssh-copy-id root@REALDOMAIN
ssh root@REALDOMAIN echo ok      # must print ok with no prompt
```

If you ever need to do it by hand, it is three files in this order — installer
and blockmap first, `latest.yml` last:

```bash
scp dist/VeloxDownloader-Setup-2.1.2.exe \
    dist/VeloxDownloader-Setup-2.1.2.exe.blockmap \
    root@REALDOMAIN:/opt/velox/updates/
scp dist/latest.yml root@REALDOMAIN:/opt/velox/updates/
curl -s https://veloxdownloader.prolanka.online/updates/latest.yml
```

**Keep the previous release's `.exe` and `.blockmap` on the server.** That pair is
what lets an older client download only the changed blocks instead of pulling the
whole ~150 MB installer again.

**The build is not code-signed** (`no signing info identified` in the build log).
Updates install fine — electron-updater verifies the sha512 from `latest.yml` — but
every new version trips Windows SmartScreen for the user. An OV/EV certificate in
`CSC_LINK` / `CSC_KEY_PASSWORD` is what removes that warning.

---

## Operations notes

- **Keep yt-dlp updated** (sites break it constantly). Add a weekly cron:
  ```bash
  0 4 * * 0 /usr/local/bin/yt-dlp -U >/dev/null 2>&1
  ```
- **YouTube may bot-check the VPS IP.** If extraction starts failing on YouTube,
  supply cookies (`--cookies`) or route extraction through a proxy pool. (This is
  the one real scaling cost.)
- **Backups:** `server/data/` holds the key DB + JWT secret — back it up.
- **Updates:** `git pull && cd server && npm install --omit=dev && pm2 restart velox-license`.
- A crashed process auto-restarts (PM2). A changed server-side check breaks any
  cracked client — that's the self-healing property.
