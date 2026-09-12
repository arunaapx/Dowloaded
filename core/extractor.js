// Server-side extraction (the crack-resistant core).
//
// This is the part that lives ONLY on the server. The thin client never has
// yt-dlp; it asks the server to (a) probe a URL for its metadata + the menu of
// download options, and (b) resolve a chosen option into direct CDN stream URLs
// the client can then fetch with its own bandwidth.
//
// No license logic here — that's enforced by the route layer (server/extract.js).

const fs = require('fs');
const { spawn } = require('child_process');
const { resolveBinary, defaultBinDir, normalizeHttpUrl, jsRuntimeArgs, jsRuntimeEnv } = require('./downloader');

function run(args, opts = {}) {
  const binDir = opts.binDir || defaultBinDir();
  return new Promise((resolve) => {
    const proc = spawn(resolveBinary('yt-dlp', binDir), args, { windowsHide: true, env: jsRuntimeEnv(binDir) });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeoutMs || 60000);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
  });
}

function netArgs(opts) {
  const a = [];
  if (Number(opts.socketTimeout) > 0) a.push('--socket-timeout', String(opts.socketTimeout));
  if (opts.maxRetries != null) a.push('--retries', String(opts.maxRetries), '--fragment-retries', String(opts.maxRetries));
  // Already resolved by the caller against the user's proxy scope, so by the
  // time it gets here it is either a proxy to use or nothing.
  if (opts.proxy) a.push('--proxy', String(opts.proxy));
  // Off unless asked for: it was measured adding ten seconds to a probe and
  // returning an identical format list, so it belongs on the retry rather than
  // on the paste every user waits through.
  a.push(...jsRuntimeArgs(opts.binDir || defaultBinDir(), opts.jsRuntime));
  return a;
}

// Extra yt-dlp args to get past YouTube's datacenter/VPS bot-check. Both are
// opt-in via env so nothing changes until the server operator sets them:
//   VELOX_YTDLP_COOKIES     path to a cookies.txt exported from a logged-in browser
//   VELOX_YT_PLAYER_CLIENTS comma list, e.g. "tv,web_safari,mweb,default"
// --cookies is harmless for non-YouTube sites; --extractor-args is YouTube-scoped.
function siteArgs() {
  const a = [];
  // Explicit file first, then the jar exported from the Browser tab session.
  const cookies = [process.env.VELOX_YTDLP_COOKIES, process.env.VELOX_YTDLP_COOKIES_AUTO]
    .find((p) => p && fs.existsSync(p));
  if (cookies) a.push('--cookies', cookies);
  // Same default as the downloader: YouTube's default client now rejects many
  // ordinary videos, and the android client still serves them.
  const raw = (process.env.VELOX_YT_PLAYER_CLIENTS || '').trim();
  if (raw.toLowerCase() !== 'off') {
    a.push('--extractor-args', `youtube:player_client=${raw || 'default,android'}`);
  }
  return a;
}

// Pick the REQUESTED quality first. On YouTube anything above 720p is adaptive
// (separate video+audio), so we must take video+audio and let the client merge
// with its bundled ffmpeg — otherwise 1080p/4K silently downgrade to 720p (the
// best progressive single file). Bias toward mp4-friendly codecs (h264 + aac) so
// the client's `-c copy` merge into mp4 works without re-encoding.
function videoSelector(quality, vCodec) {
  const heightCap = {
    best: null, '4k': 2160, '1440p': 1440, '1080p': 1080,
    '720p': 720, '480p': 480, '360p': 360,
  }[quality];
  const cap = heightCap ? `[height<=${heightCap}]` : '';
  const codecFilter = { h264: '[vcodec^=avc1]', av1: '[vcodec^=av01]', vp9: '[vcodec^=vp9]' }[vCodec] || '';

  if (codecFilter) {
    return [
      `bv*${codecFilter}${cap}+ba`,
      `bv*${cap}+ba`,
      `b${cap}`,
      'best',
    ].join('/');
  }
  return [
    `bv*[vcodec^=avc1]${cap}+ba[acodec^=mp4a]`,  // h264+aac → correct quality, mp4 copy-merge works
    `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
    `bv*${cap}+ba`,                               // any codec at the requested quality
    `b[ext=mp4]${cap}`,                           // progressive mp4 fallback
    `b${cap}`,
    'best',
  ].join('/');
}

function audioSelector() {
  return 'ba[ext=m4a]/ba/bestaudio/best';
}

const QUALITY_LADDER = [
  { id: 'best', label: 'Best available', h: Infinity },
  { id: '4k', label: '4K · 2160p', h: 2160 },
  { id: '1440p', label: '1440p', h: 1440 },
  { id: '1080p', label: '1080p · Full HD', h: 1080 },
  { id: '720p', label: '720p · HD', h: 720 },
  { id: '480p', label: '480p', h: 480 },
  { id: '360p', label: '360p', h: 360 },
];

const AUDIO_FORMATS = [
  { id: 'mp3', label: 'MP3' },
  { id: 'm4a', label: 'M4A' },
  { id: 'opus', label: 'Opus' },
  { id: 'flac', label: 'FLAC (lossless)' },
];

// Probe a URL: returns metadata + the menu of options the client should show.
async function probe(url, opts = {}) {
  const u = normalizeHttpUrl(url);
  if (!u) return { ok: false, error: 'invalid or missing url' };

  const args = ['-J', '--no-warnings', '--no-playlist', ...netArgs(opts), ...siteArgs(), u];
  const r = await run(args, opts);
  if (!r.ok) return { ok: false, error: cleanErr(r.err) || 'could not read this link' };

  let j;
  try { j = JSON.parse(r.out); } catch { return { ok: false, error: 'could not parse video info' }; }

  const heights = [...new Set((j.formats || []).map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
  const maxHeight = heights[0] || 0;
  const ceiling = Math.max(maxHeight, 360); // always allow down to 360 + Best
  const videoOptions = QUALITY_LADDER.filter((o) => o.h === Infinity || o.h <= ceiling);

  return {
    ok: true,
    meta: {
      title: j.title || '',
      uploader: j.uploader || j.channel || '',
      duration: j.duration || 0,
      thumbnail: j.thumbnail || '',
      isPlaylist: j._type === 'playlist',
      extractor: j.extractor_key || j.extractor || '',
      maxHeight,
    },
    videoOptions,
    audioOptions: AUDIO_FORMATS,
  };
}

// Resolve a chosen option into direct CDN stream URL(s) for the client to fetch.
async function resolveStreams(url, sel = {}, opts = {}) {
  const u = normalizeHttpUrl(url);
  if (!u) return { ok: false, error: 'invalid or missing url' };

  const mode = sel.mode === 'audio' ? 'audio' : 'video';
  const selector = mode === 'audio' ? audioSelector() : videoSelector(sel.quality, sel.vCodec);

  const args = ['-f', selector, '-g', '--no-warnings', '--no-playlist', ...netArgs(opts), ...siteArgs(), u];
  const r = await run(args, opts);
  if (!r.ok) return { ok: false, error: cleanErr(r.err) || 'could not resolve this video' };

  const streams = r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:/i.test(s));
  if (!streams.length) return { ok: false, error: 'no downloadable stream found' };

  const needsMerge = mode === 'video' && streams.length >= 2;
  return {
    ok: true,
    mode,
    needsMerge,                       // client must merge video+audio with ffmpeg
    streams: streams.slice(0, 2),
    container: mode === 'audio' ? (sel.aFormat || 'mp3') : 'mp4',
    headers: { Referer: u },          // many CDNs want the page as referer
  };
}

// List what a playlist, channel or mix actually contains.
//
// probe() cannot answer this: it runs with --no-playlist, so a playlist link
// resolves to a single video there and its isPlaylist flag is never true.
// --flat-playlist asks for the index only, so this costs one request instead of
// one per video: a 4-item read of a channel came back in about a second where
// resolving each entry would have taken minutes.
async function playlistEntries(url, opts = {}) {
  const u = normalizeHttpUrl(url);
  if (!u) return { ok: false, error: 'invalid or missing url' };

  // A cap, not a preference: some "playlists" are an entire channel, and mixes
  // (list=RD...) are generated forever. Reading every entry of one of those
  // would hang the paste.
  const limit = Math.max(1, Math.min(1000, parseInt(opts.limit, 10) || 200));
  const args = [
    '-J', '--flat-playlist', '--no-warnings',
    '--playlist-end', String(limit),
    ...netArgs(opts), ...siteArgs(), u,
  ];
  const r = await run(args, opts);
  if (!r.ok) return { ok: false, error: cleanErr(r.err) || 'could not read this link' };

  let j;
  try { j = JSON.parse(r.out); } catch { return { ok: false, error: 'could not read this playlist' }; }
  if (j._type !== 'playlist') return { ok: true, isPlaylist: false };

  const entries = (j.entries || [])
    .filter((e) => e && (e.url || e.id))
    .map((e, i) => ({
      index: i + 1,
      id: e.id || '',
      title: e.title || e.id || `Video ${i + 1}`,
      url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ''),
      duration: e.duration || 0,
      // Private and deleted entries stay in the index with no title; they are
      // kept so the numbering matches the playlist, but marked so the picker
      // can leave them unchecked.
      unavailable: !e.title || /^\[(private|deleted) video\]$/i.test(String(e.title)),
    }))
    .filter((e) => e.url);

  return {
    ok: true,
    isPlaylist: true,
    title: j.title || 'Playlist',
    uploader: j.uploader || j.channel || '',
    total: j.playlist_count || entries.length,
    truncated: entries.length >= limit,
    entries,
  };
}

// Search (so the client needs no local yt-dlp for the search tab).
async function search(query, limit, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty query' };
  const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
  const args = ['-J', '--flat-playlist', '--no-warnings', ...netArgs(opts), ...siteArgs(), `ytsearch${n}:${q}`];
  const r = await run(args, opts);
  if (!r.ok) return { ok: false, error: cleanErr(r.err) || 'search failed' };
  let j;
  try { j = JSON.parse(r.out); } catch { return { ok: false, error: 'could not parse search results' }; }
  const items = (j.entries || []).map((e) => ({
    id: e.id,
    title: e.title || '',
    url: e.url && /^https?:/i.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    channel: e.channel || e.uploader || '',
    duration: e.duration || 0,
    thumbnail: e.thumbnails && e.thumbnails.length
      ? e.thumbnails[e.thumbnails.length - 1].url
      : (e.thumbnail || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`),
  }));
  return { ok: true, items };
}

// Supported-sites list, cached (it barely changes and is large).
let extractorCache = null;
let extractorCacheAt = 0;
async function listExtractors(opts = {}) {
  if (extractorCache && Date.now() - extractorCacheAt < 6 * 3600 * 1000) {
    return { ok: true, list: extractorCache };
  }
  const r = await run(['--color', 'never', '--list-extractors'], { ...opts, timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: cleanErr(r.err) || 'could not list sites' };
  const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  const list = r.out.replace(ansi, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  extractorCache = list;
  extractorCacheAt = Date.now();
  return { ok: true, list };
}

function cleanErr(err) {
  if (!err) return '';
  // surface the last ERROR line yt-dlp printed, trimmed
  const line = err.split(/\r?\n/).reverse().find((l) => /error/i.test(l));
  // Keep the head of the message: yt-dlp puts the extractor and the actual
  // cause first, so trimming from the end left users reading "imeo] 99275110".
  return (line || err).replace(/^ERROR:\s*/i, '').trim().slice(0, 300);
}

module.exports = {
  playlistEntries, probe, resolveStreams, search, listExtractors, videoSelector, audioSelector };
