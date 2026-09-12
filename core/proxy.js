// Proxy settings for the download engine, the search adapters and the browser
// tab.
//
// Why this exists: YouTube rate-limits by IP. When it trips, every download on
// that connection fails until the limit clears, and the only workaround users
// had was to tether to a phone. A proxy gives the app a second exit IP without
// asking the machine to reconfigure its whole network.
//
// This is deliberately NOT a VPN. Torrent peer traffic does not pass through it
// — WebTorrent has no SOCKS support anywhere in its dependency tree — so the
// UI must never present this as protecting torrents.

const fs = require('fs');
const path = require('path');

// yt-dlp accepts http/https/socks4/socks5/socks5h. socks5h resolves DNS at the
// proxy, which matters when the block is DNS-level, so it is worth allowing.
const SCHEMES = ['http', 'https', 'socks4', 'socks5', 'socks5h'];

let state = { enabled: false, url: '', scope: 'fallback' };
let filePath = null;

// Scope decides which requests pay the proxy's latency:
//   'fallback' — nothing goes through it until YouTube refuses the connection,
//                then the refused download is retried through it
//   'youtube'  — every youtube.com/youtu.be link
//   'all'      — every download and search
//
// 'fallback' is the default because the proxies people actually have to hand
// are slow: a public free proxy is shared by thousands and is itself flagged
// before long. Paying its latency on downloads that were working anyway is a
// straight loss, and the block it works around is occasional.
const SCOPES = ['fallback', 'youtube', 'all'];

function parse(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Enter a proxy address.' };
  let u;
  try { u = new URL(text); }
  catch { return { ok: false, error: 'Not a valid address. Example: socks5://127.0.0.1:1080' }; }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (!SCHEMES.includes(scheme)) {
    return { ok: false, error: `Scheme must be one of: ${SCHEMES.join(', ')}` };
  }
  if (!u.hostname) return { ok: false, error: 'Missing host.' };
  if (!u.port && (scheme === 'socks4' || scheme === 'socks5' || scheme === 'socks5h')) {
    return { ok: false, error: 'SOCKS proxies need a port, e.g. socks5://127.0.0.1:1080' };
  }
  return { ok: true, url: u.toString().replace(/\/$/, ''), scheme, host: u.hostname, port: u.port };
}

function load(userDataDir) {
  filePath = path.join(userDataDir, 'proxy.json');
  try {
    if (!fs.existsSync(filePath)) return get();
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const parsed = parse(obj.url);
    state = {
      enabled: !!obj.enabled && parsed.ok,
      url: parsed.ok ? parsed.url : '',
      scope: SCOPES.includes(obj.scope) ? obj.scope : 'fallback',
    };
  } catch {
    // A corrupt file must not stop the app booting; start with the proxy off.
    state = { enabled: false, url: '', scope: 'fallback' };
  }
  return get();
}

function save() {
  if (!filePath) return;
  // The URL can carry a password (user:pass@host), so keep it off other
  // accounts on the machine.
  try { fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 }); } catch {}
}

function get() { return { ...state, schemes: SCHEMES }; }

function set(patch = {}) {
  const next = { ...state };
  if (patch.url !== undefined) {
    const text = String(patch.url || '').trim();
    if (!text) { next.url = ''; next.enabled = false; }
    else {
      const parsed = parse(text);
      if (!parsed.ok) return { ok: false, error: parsed.error, ...get() };
      next.url = parsed.url;
    }
  }
  if (patch.scope !== undefined && SCOPES.includes(patch.scope)) next.scope = patch.scope;
  if (patch.enabled !== undefined) {
    if (patch.enabled && !next.url) return { ok: false, error: 'Enter a proxy address first.', ...get() };
    next.enabled = !!patch.enabled;
  }
  state = next;
  save();
  return { ok: true, ...get() };
}

const YT_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$/i;

function isYouTube(url) {
  try { return YT_HOST.test(new URL(String(url)).hostname); } catch { return false; }
}

// The single question every caller asks: should THIS url go through the proxy?
function proxyFor(url) {
  if (!state.enabled || !state.url) return '';
  // Deliberately nothing on the first attempt; rescueProxyFor covers the retry.
  if (state.scope === 'fallback') return '';
  if (state.scope === 'all') return state.url;
  return isYouTube(url) ? state.url : '';
}

// The proxy to retry a refused download through, whatever the scope says. Used
// only after a direct attempt has already come back refused.
function rescueProxyFor(url) {
  if (!state.enabled || !state.url) return '';
  if (state.scope === 'all') return state.url;
  return isYouTube(url) ? state.url : '';
}

// yt-dlp argument pair, or nothing. Passing '--proxy ""' would tell yt-dlp to
// bypass a system proxy, which is not what "off" means here, so an empty
// result must stay a genuinely empty array.
function proxyArgs(url) {
  const p = proxyFor(url);
  return p ? ['--proxy', p] : [];
}

module.exports = { load, get, set, parse, proxyFor, rescueProxyFor, proxyArgs, isYouTube, SCHEMES, SCOPES };
