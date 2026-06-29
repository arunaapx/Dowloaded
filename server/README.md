# Velox License Server

Self-hosted license server + admin panel for Velox Downloader.

## Endpoints

### Public API
- `POST /api/signup` — `{ email }` → `{ ok, key, profile }` (rate-limited, 5/hr per IP)
- `POST /api/activate` — `{ key, deviceId, deviceName }` → `{ ok, token, profile }` (JWT)
- `POST /api/heartbeat` — `{ token }` → `{ ok, profile }`

Blocked, revoked, expired, or wrong-device licenses are rejected by activate and
heartbeat.

### Admin
- `GET /admin/` — Web UI
- `GET /admin/api/keys`
- `POST /admin/api/keys` — `{ email?, note?, days? }` (`days: 0` = lifetime)
- `PATCH /admin/api/keys/:key` — edit email, note, or expiry
- `POST /admin/api/keys/:key/extend` — `{ days }`
- `POST /admin/api/keys/:key/block`
- `POST /admin/api/keys/:key/unblock`
- `POST /admin/api/keys/:key/revoke`
- `POST /admin/api/keys/:key/unrevoke`
- `POST /admin/api/keys/:key/reset-device`
- `DELETE /admin/api/keys/:key`

### Health
- `GET /healthz`

## Local run

```
cd server
cp .env.example .env
# edit ADMIN_PASS
npm install
npm start
```

Open http://localhost:4000/admin and log in.

## Deploy to a Linux VPS

```bash
# On the server, as a non-root user:
sudo apt update && sudo apt install -y nodejs npm git
git clone <your-fork-of-Dowloaded> /opt/velox-license
cd /opt/velox-license/server
cp .env.example .env
$EDITOR .env       # set ADMIN_USER, ADMIN_PASS
npm install --omit=dev
```

### systemd service

Create `/etc/systemd/system/velox-license.service`:

```ini
[Unit]
Description=Velox License Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/velox-license/server
EnvironmentFile=/opt/velox-license/server/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now velox-license
sudo systemctl status velox-license
```

### Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name api.yourdomain.com;
  ssl_certificate     /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Or with Caddy:

```caddyfile
api.yourdomain.com {
  reverse_proxy 127.0.0.1:4000
}
```

## Data

All state lives in `./data/` (override with `DATA_DIR` env var):

- `licenses.json` — license/key database
- `.jwt-secret` — auto-generated JWT signing secret (chmod 600)

Back up the `data/` folder.

## Wire the client to your server

The Electron app now defaults to the local license server:

```
http://localhost:4000
```

That means keys created in the local admin panel activate immediately while the
server is running on the same machine.

For a hosted/VPS license server, set the env var `LICENSE_SERVER_URL` when
launching the app:

```
$env:LICENSE_SERVER_URL = "https://api.yourdomain.com"
npm start
```

For a packaged `.exe`, change the fallback URL in `main.js` to your hosted
server URL before building.

## Notes on cracking

This is a deterrent, not an unbreakable wall:
- All Electron clients can be unpacked (`npx asar extract`) and edited.
- The strategy is: revoke quickly + push auto-updates that remove the offending build.
- Don't put any secret in the client. The JWT_SECRET stays on the server.
