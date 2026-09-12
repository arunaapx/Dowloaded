// The YouTube cookie jar the extractor uses, and the admin panel manages.
//
// YouTube refuses an increasing share of videos to anonymous requests with
// "Sign in to confirm you're not a bot". That gate is not about the address —
// measured from a clean residential line, the watch page returns 200 while
// /youtubei/v1/player still refuses — and no player client, JS runtime or proxy
// gets past it. yt-dlp's own answer is the only one that works: send cookies
// from a signed-in session.
//
// ── TREAT THIS FILE AS A PASSWORD ──────────────────────────────────────────
// A cookies.txt for youtube.com carries LIVE Google session tokens. Anyone
// holding it is signed in as that account until the cookies expire or the
// account signs out everywhere. So:
//   * it is stored under DATA_DIR, which is gitignored, with 0600 where the
//     platform honours it;
//   * it is NEVER sent back to the browser, not even to the admin who uploaded
//     it — status() returns counts and dates, never a value;
//   * nothing here writes cookie contents to a log.
//
// Use an account you are willing to lose. YouTube's terms do not allow this,
// and accounts used this way do get banned.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE_FILE = path.join(DATA_DIR, 'yt-cookies.txt');

/// Cookies that actually carry a Google session. If none of these are present
/// the file will not authenticate anything, however many lines it has — which
/// is the most common upload mistake (exporting from a logged-out tab, or
/// exporting only the current page's cookies).
const SESSION_COOKIES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  'LOGIN_INFO',
];

const GOOGLE_DOMAINS = /(^|\.)(youtube\.com|google\.com)$/i;

/// Netscape cookies.txt: domain, includeSubdomains, path, secure, expiry,
/// name, value — tab separated. A leading "#HttpOnly_" prefix is a Chrome
/// extension convention and is part of the domain field.
function parse(text) {
  const cookies = [];
  const problems = [];
  let sawHeader = false;

  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/netscape http cookie file/i.test(line)) sawHeader = true;
      // #HttpOnly_ lines are real cookies wearing a comment-looking prefix.
      if (!line.startsWith('#HttpOnly_')) continue;
    }

    const parts = raw.replace(/^#HttpOnly_/, '').split('\t');
    if (parts.length < 7) {
      problems.push('a line was not tab-separated into seven fields');
      continue;
    }
    const [domain, , cookiePath, secure, expiry, name] = parts;
    cookies.push({
      domain: domain.replace(/^\./, '').toLowerCase(),
      path: cookiePath,
      secure: secure === 'TRUE',
      // 0 means a session cookie: it dies with the browser and is useless here.
      expiry: Number(expiry) || 0,
      name,
    });
  }

  return { cookies, problems: [...new Set(problems)], sawHeader };
}

/// What is wrong with this file, in the order it matters. Empty means usable.
function faults(parsed) {
  const out = [];
  if (!parsed.cookies.length) {
    out.push('No cookies found. Export in Netscape format (cookies.txt), not JSON.');
    return out;
  }

  const google = parsed.cookies.filter((c) => GOOGLE_DOMAINS.test(c.domain));
  if (!google.length) {
    out.push('No youtube.com or google.com cookies. Export while on youtube.com.');
    return out;
  }

  const session = google.filter((c) => SESSION_COOKIES.includes(c.name));
  if (!session.length) {
    out.push('No session cookies (SID/SAPISID/__Secure-1PSID). Sign in first, then export.');
  }

  const now = Math.floor(Date.now() / 1000);
  const live = session.filter((c) => c.expiry > now);
  if (session.length && !live.length) {
    out.push('Every session cookie has already expired. Export a fresh copy.');
  }

  return out;
}

function summarise(parsed) {
  const now = Math.floor(Date.now() / 1000);
  const google = parsed.cookies.filter((c) => GOOGLE_DOMAINS.test(c.domain));
  const session = google.filter((c) => SESSION_COOKIES.includes(c.name));
  const expiries = session.map((c) => c.expiry).filter((e) => e > 0);

  return {
    total: parsed.cookies.length,
    google: google.length,
    session: session.length,
    // The names only — never the values.
    sessionNames: session.map((c) => c.name).sort(),
    domains: [...new Set(parsed.cookies.map((c) => c.domain))].sort().slice(0, 12),
    expiresAt: expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null,
    expiredCount: session.filter((c) => c.expiry > 0 && c.expiry <= now).length,
  };
}

/// Point the extractor at the stored jar, or away from it when there is none.
///
/// core/extractor.js reads VELOX_YTDLP_COOKIES from the environment, the same
/// way the desktop app feeds it the jar exported from its Browser tab. Setting
/// it here rather than threading a path through every call keeps that one
/// convention, and means an operator who prefers to set the env var by hand
/// still gets exactly the behaviour they expect.
function apply() {
  if (fs.existsSync(COOKIE_FILE)) {
    process.env.VELOX_YTDLP_COOKIES = COOKIE_FILE;
    return true;
  }
  // Only clear what we set. An operator-supplied path pointing elsewhere is
  // theirs and must survive.
  if (process.env.VELOX_YTDLP_COOKIES === COOKIE_FILE) {
    delete process.env.VELOX_YTDLP_COOKIES;
  }
  return false;
}

/// Validate and store an uploaded jar. Returns { ok, error?, summary }.
function save(text) {
  const parsed = parse(text);
  const bad = faults(parsed);
  if (bad.length) {
    return { ok: false, error: bad[0], problems: bad, summary: summarise(parsed) };
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Written through a temp file so a failed write cannot leave a half-file
  // that would authenticate as nobody and fail every extraction.
  const tmp = `${COOKIE_FILE}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, COOKIE_FILE);
  try { fs.chmodSync(COOKIE_FILE, 0o600); } catch {}

  apply();
  return { ok: true, summary: summarise(parsed) };
}

function clear() {
  try { fs.rmSync(COOKIE_FILE, { force: true }); } catch {}
  apply();
  return { ok: true };
}

/// Metadata only. There is no path by which the file's contents leave here.
function status() {
  if (!fs.existsSync(COOKIE_FILE)) {
    return { present: false, active: false };
  }
  let parsed;
  try {
    parsed = parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
  } catch (e) {
    return { present: true, active: false, error: `unreadable: ${e.message}` };
  }
  const stat = fs.statSync(COOKIE_FILE);
  const bad = faults(parsed);
  return {
    present: true,
    active: process.env.VELOX_YTDLP_COOKIES === COOKIE_FILE,
    uploadedAt: stat.mtime.toISOString(),
    bytes: stat.size,
    problems: bad,
    ...summarise(parsed),
  };
}

module.exports = { save, clear, status, apply, COOKIE_FILE };
