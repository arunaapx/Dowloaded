// Per-site search for the Search tab.
//
// Three ways a site can be searched, in descending order of usefulness:
//
//   1. adapter  — the site has a usable search API, a scrapable results page,
//                 or yt-dlp can read its search page as a playlist. Results
//                 come straight back into the Search tab with title,
//                 thumbnail and duration, ready to download.
//   2. browser  — no machine-readable search, but the site has a search URL.
//                 The renderer opens it in the built-in browser tab, where
//                 "DOWNLOAD THIS PAGE" still works.
//   3. link     — a yt-dlp extractor we have no search entry point for. The
//                 user pastes a link instead.
//
// Every adapter returns the same item shape:
//   { title, url, thumbnail, duration, uploader, site }

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CATEGORIES, SITES, getSite, searchUrlFor } = require('./site-catalog');
const { resolveBinary, defaultBinDir, scrubEngineName } = require('./downloader');

let axios = null;
let cheerio = null;
try { axios = require('axios'); } catch { /* optional */ }
try { cheerio = require('cheerio'); } catch { /* optional */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HTML_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const JSON_HEADERS = { 'User-Agent': UA, Accept: 'application/json' };
const HTTP_TIMEOUT = 20000;

// ---------------------------------------------------------------- utilities

function clampLimit(limit) {
  return Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
}

function absolute(base, href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  return base.replace(/\/+$/, '') + (href.startsWith('/') ? href : '/' + href);
}

// "12:34" / "1:02:03" / "15 sec" / "25min" -> seconds
function parseDuration(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const clock = /(\d+):(\d{2})(?::(\d{2}))?/.exec(t);
  if (clock) {
    const a = Number(clock[1]), b = Number(clock[2]), c = clock[3] != null ? Number(clock[3]) : null;
    return c != null ? a * 3600 + b * 60 + c : a * 60 + b;
  }
  let secs = 0, found = false;
  const h = /(\d+)\s*h/i.exec(t); if (h) { secs += Number(h[1]) * 3600; found = true; }
  const m = /(\d+)\s*min/i.exec(t); if (m) { secs += Number(m[1]) * 60; found = true; }
  const s = /(\d+)\s*sec/i.exec(t); if (s) { secs += Number(s[1]); found = true; }
  return found ? secs : 0;
}

// Search APIs happily return &amp; and <em> highlight tags inside titles.
function stripMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function item(site, o) {
  return {
    title: stripMarkup(o.title),
    url: String(o.url || '').trim(),
    thumbnail: String(o.thumbnail || '').trim(),
    duration: Number(o.duration) || 0,
    uploader: String(o.uploader || '').trim(),
    site: site.name,
    siteId: site.id,
    // Set only for playlist results, so the UI can show a playlist card and
    // open the picker instead of queueing one video.
    isPlaylist: !!o.isPlaylist,
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    if (!i.url || !i.title || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

async function getJson(url, params, headers) {
  const r = await axios.get(url, { params, headers: { ...JSON_HEADERS, ...(headers || {}) }, timeout: HTTP_TIMEOUT });
  return r.data;
}

async function getHtml(url) {
  const r = await axios.get(url, { headers: HTML_HEADERS, timeout: HTTP_TIMEOUT });
  return cheerio.load(r.data);
}

// -------------------------------------------------- fast paths without yt-dlp
//
// Spawning yt-dlp costs ~3.4s before it touches the network, which dominates a
// search. The busiest sites are reachable over plain HTTP in about a second,
// so they go direct and fall back to yt-dlp only if that breaks.

// YouTube ships its results as one very large JSON blob, so walk it exactly
// once and pull out both the videos and the "next page" token together.
function scanYouTube(data, pickVideo) {
  const items = [];
  let continuation = null;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer) {
      const it = pickVideo(node.videoRenderer);
      if (it) items.push(it);
    } else if (!continuation && node.continuationItemRenderer) {
      const cmd = (node.continuationItemRenderer.continuationEndpoint || {}).continuationCommand;
      if (cmd && cmd.token) continuation = cmd.token;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  })(data);
  return { items, continuation };
}

// YouTube pages its results with an opaque continuation token, so remember the
// token per search and hand it back when the next page is asked for.
const ytContinuations = new Map();

function feedKey(siteId, q) { return siteId + '|' + q.toLowerCase(); }

function rememberContinuation(key, page, token) {
  if (ytContinuations.size > 40) ytContinuations.clear();
  if (token) ytContinuations.set(key, { page, token });
  else ytContinuations.delete(key);
}

// An ok result with no items and `final` set means "the source is genuinely
// out", so the caller must not spend 3.4s asking yt-dlp the same question.
function exhausted() { return { ok: true, items: [], final: true }; }

// YouTube's playlist results are lockupViewModel, not videoRenderer: a
// different shape entirely, with the playlist id in contentId and the title
// and channel buried in nested "content" strings.
function scanYouTubePlaylists(site, data) {
  const items = [];
  let continuation = null;

  const firstText = (node, out) => {
    if (!node || typeof node !== 'object') return out;
    if (typeof node.content === 'string') out.push(node.content);
    for (const k of Object.keys(node)) firstText(node[k], out);
    return out;
  };
  const firstThumb = (node) => {
    if (!node || typeof node !== 'object') return '';
    if (typeof node.url === 'string' && node.url.includes('ytimg')) return node.url;
    for (const k of Object.keys(node)) {
      const r = firstThumb(node[k]);
      if (r) return r;
    }
    return '';
  };

  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const lv = node.lockupViewModel;
    if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' && lv.contentId) {
      const texts = firstText(lv.metadata, []);
      const title = texts[0] || '';
      // texts[1] is the channel; texts[2] is the literal word "Playlist".
      const uploader = texts[1] && texts[1] !== 'Playlist' ? texts[1] : '';
      if (title) {
        items.push(item(site, {
          title,
          url: `https://www.youtube.com/playlist?list=${lv.contentId}`,
          thumbnail: firstThumb(lv.contentImage),
          uploader,
          isPlaylist: true,
        }));
      }
    } else if (!continuation && node.continuationItemRenderer) {
      const cmd = (node.continuationItemRenderer.continuationEndpoint || {}).continuationCommand;
      if (cmd && cmd.token) continuation = cmd.token;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(data);

  return { items, continuation };
}

function ytVideoItem(site, v) {
  if (!v || !v.videoId || !v.title) return null;
  const title = (v.title.runs && v.title.runs[0] && v.title.runs[0].text) || v.title.simpleText || '';
  if (!title) return null;
  const thumbs = (v.thumbnail && v.thumbnail.thumbnails) || [];
  const by = (v.ownerText && v.ownerText.runs) || (v.longBylineText && v.longBylineText.runs) || [];
  return item(site, {
    title,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    duration: parseDuration(v.lengthText && v.lengthText.simpleText),
    uploader: by.length ? by[0].text : '',
  });
}

function innertubeBody(clientName, clientVersion) {
  return { context: { client: { clientName, clientVersion, hl: 'en', gl: 'US' } } };
}

async function youtubeHttpSearch(site, q, limit, page, kind) {
  const playlists = kind === 'playlist';
  // Separate continuation feeds: paging a video search must not continue from
  // a playlist search of the same words.
  const key = feedKey(site.id, (playlists ? 'pl:' : '') + q);
  const read = (data) => (playlists
    ? scanYouTubePlaylists(site, data)
    : scanYouTube(data, (v) => ytVideoItem(site, v)));

  // Later pages continue the first page's result set.
  if (page > 1) {
    const saved = ytContinuations.get(key);
    if (!saved || saved.page !== page - 1) return null; // no token: let yt-dlp take it
    const body = { ...innertubeBody('WEB', '2.20240401.00.00'), continuation: saved.token };
    const r = await axios.post('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', body,
      { headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT });
    const { items, continuation } = read(r.data);
    rememberContinuation(key, page, continuation);
    if (!items.length) return exhausted();
    return { ok: true, items: dedupe(items).slice(0, limit) };
  }

  // Page 1: the search page ships its results inside ytInitialData.
  const r = await axios.get('https://www.youtube.com/results', {
    // sp is YouTube's own result filter: EgIQAQ== videos, EgIQAw== playlists.
    params: { search_query: q, sp: playlists ? 'EgIQAw==' : 'EgIQAQ==' },
    headers: HTML_HEADERS, timeout: HTTP_TIMEOUT,
  });
  const m = /ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s.exec(r.data)
    || /ytInitialData"\]\s*=\s*(\{.+?\});/s.exec(r.data);
  if (!m) return null;

  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }

  const { items, continuation } = read(data);
  if (!items.length) return null;
  rememberContinuation(key, 1, continuation);
  return { ok: true, items: dedupe(items).slice(0, limit) };
}

// YouTube Music speaks the same InnerTube API under a different client name.
async function youtubeMusicHttpSearch(site, q, limit, page) {
  const key = feedKey(site.id, q);
  const saved = page > 1 ? ytContinuations.get(key) : null;
  if (page > 1 && (!saved || saved.page !== page - 1)) return exhausted();

  const body = innertubeBody('WEB_REMIX', '1.20240401.01.00');
  if (page > 1) body.continuation = saved.token;
  else { body.query = q; body.params = 'EgWKAQIIAWoKEAoQCRADEAQQBQ%3D%3D'; } // songs + videos

  const r = await axios.post('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', body, {
    headers: {
      ...JSON_HEADERS, 'Content-Type': 'application/json',
      Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/',
    },
    timeout: HTTP_TIMEOUT,
  });

  const items = [];
  let continuation = null;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const x = node.musicResponsiveListItemRenderer;
    if (x) {
      const overlay = ((((x.overlay || {}).musicItemThumbnailOverlayRenderer || {}).content || {}).musicPlayButtonRenderer || {});
      const id = (x.playlistItemData && x.playlistItemData.videoId)
        || ((overlay.playNavigationEndpoint || {}).watchEndpoint || {}).videoId;
      const cols = x.flexColumns || [];
      const runs = (((cols[0] || {}).musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || [];
      const title = runs.length ? runs[0].text : '';
      if (id && title) {
        const sub = (((cols[1] || {}).musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || [];
        const list = ((((x.thumbnail || {}).musicThumbnailRenderer || {}).thumbnail || {}).thumbnails) || [];
        items.push(item(site, {
          title,
          url: `https://music.youtube.com/watch?v=${id}`,
          thumbnail: list.length ? list[list.length - 1].url : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          duration: parseDuration(sub.length ? sub[sub.length - 1].text : ''),
          uploader: sub.length ? sub[0].text : '',
        }));
      }
    } else if (!continuation && node.continuationItemRenderer) {
      const cmd = (node.continuationItemRenderer.continuationEndpoint || {}).continuationCommand;
      if (cmd && cmd.token) continuation = cmd.token;
    }
    for (const key2 of Object.keys(node)) walk(node[key2]);
  })(r.data);

  rememberContinuation(key, page, continuation);
  if (!items.length) return page > 1 ? exhausted() : null;
  return { ok: true, items: dedupe(items).slice(0, limit) };
}

// Pornhub's own search page carries thumbnails and durations that yt-dlp's
// flat playlist does not, and answers in a fraction of the time.
async function pornhubHttpSearch(site, q, limit, page) {
  const $ = await getHtml(`https://www.pornhub.com/video/search?search=${encodeURIComponent(q)}&page=${page}`);
  const items = [];
  $('li.pcVideoListItem').each((_i, el) => {
    if (items.length >= limit) return false;
    const $el = $(el);
    const $a = $el.find('a.linkVideoThumb, a[href*="viewkey"]').first();
    const href = ($a.attr('href') || '').split('&')[0];
    if (!/viewkey=/.test(href)) return;
    const title = ($a.attr('title') || $el.find('.title a').text() || '').trim();
    if (!title) return;
    items.push(item(site, {
      title,
      url: absolute('https://www.pornhub.com', href),
      thumbnail: $el.find('img').attr('data-src') || $el.find('img').attr('src') || '',
      duration: parseDuration($el.find('var.duration').first().text()),
    }));
  });
  if (!items.length) return page > 1 ? exhausted() : null;
  return { ok: true, items: dedupe(items) };
}

// SoundCloud's public API needs the client_id its own web player uses; it is
// sitting in their JS bundle and changes rarely, so fetch it once and keep it.
let scClientId = null;
let scClientIdAt = 0;

async function soundcloudClientId() {
  if (scClientId && Date.now() - scClientIdAt < 12 * 3600 * 1000) return scClientId;
  const home = await axios.get('https://soundcloud.com/discover', { headers: HTML_HEADERS, timeout: HTTP_TIMEOUT });
  const scripts = [...String(home.data).matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1]).reverse();
  for (const src of scripts) {
    try {
      const js = await axios.get(src, { headers: HTML_HEADERS, timeout: HTTP_TIMEOUT });
      const m = /client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/.exec(js.data);
      if (m) { scClientId = m[1]; scClientIdAt = Date.now(); return scClientId; }
    } catch { /* try the next bundle */ }
  }
  return null;
}

async function soundcloudHttpSearch(site, q, limit, page) {
  const clientId = await soundcloudClientId();
  if (!clientId) return null;
  const d = await getJson('https://api-v2.soundcloud.com/search/tracks', {
    q, client_id: clientId, limit, offset: (page - 1) * limit,
  });
  const rows = (d && d.collection) || [];
  if (!rows.length) return null;
  return {
    ok: true,
    items: dedupe(rows.map((t) => item(site, {
      title: t.title,
      url: t.permalink_url,
      thumbnail: t.artwork_url || (t.user && t.user.avatar_url),
      duration: Math.round((t.duration || 0) / 1000),
      uploader: t.user && t.user.username,
    }))).slice(0, limit),
  };
}


// Vimeo's web player hands out a short-lived anonymous JWT. It is good for
// well over a minute, so cache it instead of paying for it every search.
let vimeoJwt = null;
let vimeoJwtAt = 0;

async function vimeoToken() {
  if (vimeoJwt && Date.now() - vimeoJwtAt < 10 * 60 * 1000) return vimeoJwt;
  const viewer = await getJson('https://vimeo.com/_next/viewer', null, HTML_HEADERS);
  vimeoJwt = (viewer && viewer.jwt) || null;
  vimeoJwtAt = Date.now();
  return vimeoJwt;
}
// ------------------------------------------------------------ yt-dlp bridge

function runYtdlp(args, opts = {}) {
  const binDir = opts.binDir || defaultBinDir();
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveBinary('yt-dlp', binDir), args, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, err: e.message });
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeoutMs || 60000);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
  });
}

function ytdlpError(err) {
  if (!err) return '';
  const line = err.split(/\r?\n/).reverse().find((l) => /error/i.test(l));
  // Same rule as the downloader: the customer gets the meaning, not the name
  // of the engine that produced it.
  return scrubEngineName((line || err).replace(/^ERROR:\s*/i, '').trim()).slice(-200);
}

// yt-dlp gives us a flat playlist; map its entries onto our item shape.
// `start` and `end` are 1-based inclusive positions in that playlist, which is
// how later pages are fetched without re-sending everything already shown.
async function ytdlpSearch(site, target, start, end, opts) {
  const r = await runYtdlp(
    ['--flat-playlist', '-J', '--no-warnings',
      '--playlist-start', String(start), '--playlist-end', String(end),
      '--socket-timeout', '20', target],
    { ...opts, timeoutMs: 90000 },
  );
  if (!r.ok) return { ok: false, error: ytdlpError(r.err) || 'search failed' };

  let j;
  try { j = JSON.parse(r.out); } catch { return { ok: false, error: 'could not read the search results' }; }

  const entries = Array.isArray(j.entries) ? j.entries : [];
  const items = entries.map((e) => {
    let url = e.webpage_url || e.url || '';
    if (url && !/^https?:/i.test(url) && e.id) url = `https://www.youtube.com/watch?v=${e.id}`;
    if (/^http:\/\//i.test(url)) url = url.replace(/^http:/i, 'https:');
    const thumbs = Array.isArray(e.thumbnails) ? e.thumbnails : [];
    // A flat playlist often omits thumbnails. Anything backed by a YouTube
    // video id (YouTube itself, YouTube Music) can have one derived.
    const ytId = /[?&]v=([\w-]{11})/.exec(url);
    return item(site, {
      title: e.title || e.id || '',
      url,
      thumbnail: e.thumbnail
        || (thumbs.length ? thumbs[thumbs.length - 1].url : '')
        || (ytId ? `https://i.ytimg.com/vi/${ytId[1]}/mqdefault.jpg` : ''),
      duration: e.duration,
      uploader: e.uploader || e.channel || e.uploader_id || '',
    });
  });
  return { ok: true, items: dedupe(items) };
}

// -------------------------------------------------------------- adapters

// Run the fast HTTP path, dropping to the slow one if it returns nothing or
// throws. A null result means "I could not answer", not "no results".
async function withFallback(fastPromise, slow) {
  try {
    const fast = await fastPromise;
    if (fast && fast.ok && fast.items && fast.items.length) return fast;
    // A final result means the fast path knows there is nothing more, so
    // asking yt-dlp would spend another 3.4s learning the same thing.
    if (fast && fast.final) return { ok: true, items: [] };
  } catch (e) { /* fall through to yt-dlp */ }
  return slow();
}

// Every adapter takes (site, query, limit, opts, page) with page 1-based, and
// returns at most `limit` items for that page. Infinite scroll in the Search
// tab just walks the pages.
const ADAPTERS = {
  // yt-dlp's own search prefixes: ytsearch, scsearch.
  'ytdlp-prefix': (site, q, limit, opts, page) => {
    const end = page * limit;
    return ytdlpSearch(site, `${site.prefix}${end}:${q}`, (page - 1) * limit + 1, end, opts);
  },

  // HTTP first, yt-dlp only if the fast path breaks.
  youtube: (site, q, limit, opts, page) =>
    // No yt-dlp fallback for playlists: ytsearch only ever returns videos, so
    // falling back would quietly answer a playlist search with videos.
    (opts.kind === 'playlist'
      ? youtubeHttpSearch(site, q, limit, page, 'playlist')
        .then((r) => r || { ok: true, items: [], final: true })
      : withFallback(youtubeHttpSearch(site, q, limit, page),
        () => ADAPTERS['ytdlp-prefix'](site, q, limit, opts, page))),

  youtubemusic: (site, q, limit, opts, page) =>
    withFallback(youtubeMusicHttpSearch(site, q, limit, page),
      () => ADAPTERS['ytdlp-url'](site, q, limit, opts, page)),

  soundcloud: (site, q, limit, opts, page) =>
    withFallback(soundcloudHttpSearch(site, q, limit, page),
      () => ADAPTERS['ytdlp-prefix'](site, q, limit, opts, page)),

  pornhub: (site, q, limit, opts, page) =>
    withFallback(pornhubHttpSearch(site, q, limit, page),
      () => ADAPTERS['ytdlp-url'](site, q, limit, opts, page)),

  // The site's own search page, read by yt-dlp as a playlist. Those pages mix
  // playlists, channels and albums in with the videos, so read a wider window
  // than we need and keep only the entries that point at something playable.
  'ytdlp-url': async (site, q, limit, opts, page) => {
    const window = limit * 3;
    const start = (page - 1) * window + 1;
    const res = await ytdlpSearch(site, searchUrlFor(site, q), start, start + window - 1, opts);
    if (!res.ok) return res;
    const playable = res.items.filter((i) =>
      !/\/(browse|channel|playlist|user|model|pornstar|categories)\//i.test(i.url) &&
      !/[?&]list=/i.test(i.url));
    return { ok: true, items: (playable.length ? playable : res.items).slice(0, limit) };
  },

  // Bilibili's own search API answers once a homepage visit has handed out a
  // buvid cookie. yt-dlp's bilisearch works too, but returns no titles.
  bilibili: async (site, q, limit, opts, page) => {
    const home = await axios.get('https://www.bilibili.com/', { headers: HTML_HEADERS, timeout: HTTP_TIMEOUT });
    const cookie = (home.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    const d = await getJson('https://api.bilibili.com/x/web-interface/search/type',
      { search_type: 'video', keyword: q, page },
      { Cookie: cookie, Referer: 'https://search.bilibili.com/' });
    if (d && d.code !== 0) return { ok: false, error: `Bilibili refused the search (${d.message || d.code}).` };
    const rows = (d && d.data && d.data.result) || [];
    return {
      ok: true,
      items: dedupe(rows.slice(0, limit).map((v) => item(site, {
        title: v.title,
        url: String(v.arcurl || '').replace(/^http:/i, 'https:'),
        thumbnail: absolute('https:', v.pic),
        duration: parseDuration(v.duration),
        uploader: v.author,
      }))),
    };
  },

  dailymotion: async (site, q, limit, opts, page) => {
    const d = await getJson('https://api.dailymotion.com/videos', {
      search: q, limit, page, fields: 'id,title,url,duration,thumbnail_360_url,owner.screenname',
    });
    return {
      ok: true,
      items: dedupe((d.list || []).map((v) => item(site, {
        title: v.title, url: v.url, duration: v.duration,
        thumbnail: v.thumbnail_360_url, uploader: v['owner.screenname'],
      }))),
    };
  },

  vimeo: async (site, q, limit, opts, page) => {
    // Vimeo's web player hands out a short-lived anonymous JWT; the public
    // API accepts it, so no API key has to ship with the app.
    const jwt = await vimeoToken();
    if (!jwt) return { ok: false, error: 'Vimeo did not hand out a session token' };
    const d = await getJson('https://api.vimeo.com/videos', {
      query: q, per_page: limit, page, fields: 'name,link,duration,pictures.sizes,user.name',
    }, { Authorization: 'jwt ' + jwt, Accept: 'application/vnd.vimeo.*+json;version=3.4' });
    return {
      ok: true,
      items: dedupe((d.data || []).map((v) => {
        const sizes = (v.pictures && v.pictures.sizes) || [];
        return item(site, {
          title: v.name, url: v.link, duration: v.duration,
          thumbnail: sizes.length ? sizes[Math.min(2, sizes.length - 1)].link : '',
          uploader: v.user && v.user.name,
        });
      })),
    };
  },

  // Bandcamp's autocomplete returns a single fixed batch, so there is no
  // second page to walk.
  bandcamp: async (site, q, limit, opts, page) => {
    if (page > 1) return { ok: true, items: [] };
    const r = await axios.post(
      'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic',
      { search_text: q, search_filter: 't', full_page: false, fan_id: null },
      { headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT },
    );
    const results = (r.data && r.data.auto && r.data.auto.results) || [];
    return {
      ok: true,
      items: dedupe(results.slice(0, limit).map((t) => item(site, {
        title: t.name, url: t.item_url_path || t.url, thumbnail: t.img, uploader: t.band_name,
      }))),
    };
  },

  mixcloud: async (site, q, limit, opts, page) => {
    const d = await getJson('https://api.mixcloud.com/search/', { q, type: 'cloudcast', limit, offset: (page - 1) * limit });
    return {
      ok: true,
      items: dedupe((d.data || []).map((c) => item(site, {
        title: c.name, url: c.url, duration: c.audio_length,
        thumbnail: c.pictures && (c.pictures.medium || c.pictures.large),
        uploader: c.user && c.user.name,
      }))),
    };
  },

  bitchute: async (site, q, limit, opts, page) => {
    const r = await axios.post(
      'https://api.bitchute.com/api/beta/search/videos',
      { offset: (page - 1) * limit, limit, query: q, sensitivity_id: 'normal', sort: 'new' },
      { headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT },
    );
    const vids = (r.data && r.data.videos) || [];
    return {
      ok: true,
      items: dedupe(vids.map((v) => item(site, {
        title: v.video_name,
        url: `https://www.bitchute.com/video/${v.video_id}/`,
        thumbnail: v.thumbnail_url,
        duration: parseDuration(v.duration),
        uploader: v.channel && v.channel.channel_name,
      }))),
    };
  },

  niconico: async (site, q, limit, opts, page) => {
    const d = await getJson('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search', {
      q, targets: 'title,description,tags',
      fields: 'contentId,title,thumbnailUrl,lengthSeconds',
      _sort: '-viewCounter', _limit: limit, _offset: (page - 1) * limit, _context: 'VeloxDownloader',
    });
    return {
      ok: true,
      items: dedupe((d.data || []).map((v) => item(site, {
        title: v.title,
        url: `https://www.nicovideo.jp/watch/${v.contentId}`,
        thumbnail: v.thumbnailUrl,
        duration: v.lengthSeconds,
      }))),
    };
  },

  // SepiaSearch indexes public PeerTube instances, so one query covers the
  // whole federation instead of a single instance.
  peertube: async (site, q, limit, opts, page) => {
    const d = await getJson('https://sepiasearch.org/api/v1/search/videos', { search: q, count: limit, start: (page - 1) * limit });
    return {
      ok: true,
      items: dedupe((d.data || []).map((v) => item(site, {
        title: v.name, url: v.url, duration: v.duration,
        thumbnail: v.thumbnailUrl || (v.account && v.account.avatar && v.account.avatar.path),
        uploader: (v.channel && v.channel.displayName) || (v.account && v.account.displayName),
      }))),
    };
  },

  odysee: async (site, q, limit, opts, page) => {
    const rows = await getJson('https://lighthouse.odysee.tv/search', {
      s: q, size: limit, from: (page - 1) * limit, claimType: 'file', mediaType: 'video',
    });
    const base = (Array.isArray(rows) ? rows : []).filter((r) => r && r.name && r.claimId);
    const urls = base.map((r) => `lbry://${r.name}#${r.claimId}`);

    // Lighthouse only returns claim ids; resolve them for real titles/thumbs.
    let meta = {};
    if (urls.length) {
      try {
        const r = await axios.post('https://api.na-backend.odysee.com/api/v1/proxy?m=resolve',
          { jsonrpc: '2.0', method: 'resolve', params: { urls }, id: Date.now() },
          { headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT });
        meta = (r.data && r.data.result) || {};
      } catch { /* fall back to the claim name below */ }
    }

    return {
      ok: true,
      items: dedupe(base.map((r, i) => {
        const m = meta[urls[i]] || {};
        const v = (m.value && typeof m.value === 'object') ? m.value : {};
        return item(site, {
          title: v.title || String(r.name).replace(/[-_]+/g, ' '),
          url: `https://odysee.com/${r.name}:${r.claimId}`,
          thumbnail: v.thumbnail && v.thumbnail.url,
          duration: (v.video && v.video.duration) || (v.audio && v.audio.duration) || 0,
          uploader: m.signing_channel && (m.signing_channel.name || ''),
        });
      })),
    };
  },

  archive: async (site, q, limit, opts, page) => {
    const d = await getJson('https://archive.org/advancedsearch.php', {
      q: `(${q}) AND (mediatype:movies OR mediatype:audio)`,
      'fl[]': ['identifier', 'title', 'creator', 'mediatype'],
      rows: limit, page, output: 'json',
    });
    const docs = (d.response && d.response.docs) || [];
    return {
      ok: true,
      items: dedupe(docs.map((doc) => item(site, {
        title: doc.title || doc.identifier,
        url: `https://archive.org/details/${doc.identifier}`,
        thumbnail: `https://archive.org/services/img/${doc.identifier}`,
        uploader: Array.isArray(doc.creator) ? doc.creator[0] : doc.creator,
      }))),
    };
  },

  eporner: async (site, q, limit, opts, page) => {
    const d = await getJson('https://www.eporner.com/api/v2/video/search/', {
      query: q, per_page: Math.min(limit, 100), page, format: 'json', thumbsize: 'medium',
    });
    return {
      ok: true,
      items: dedupe((d.videos || []).map((v) => item(site, {
        title: v.title, url: v.url,
        thumbnail: (v.default_thumb && v.default_thumb.src) || '',
        duration: parseDuration(v.length_min) || Number(v.length_sec) || 0,
        uploader: v.added,
      }))),
    };
  },

  xvideos: (site, q, limit, opts, page) => scrapeXTube(site, q, limit, page, 'https://www.xvideos.com'),
  xnxx: (site, q, limit, opts, page) => scrapeXTube(site, q, limit, page, 'https://www.xnxx.com'),

  xhamster: async (site, q, limit, opts, page) => {
    const $ = await getHtml(searchUrlFor(site, q) + (page > 1 ? '?page=' + page : ''));
    const items = [];
    const seen = new Set();
    $('a[href*="/videos/"]').each((_i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const href = $el.attr('href') || '';
      // Only real watch pages: /creators/videos/... and the thumbnail <a>
      // wrappers (whose text is raw markup) both match a looser pattern.
      if (!/^https?:\/\/[^/]*xhamster\.[a-z]+\/videos\/[^/]+$/i.test(href)) return;
      const title = ($el.attr('title') || $el.text() || '').trim();
      if (!title || title.startsWith('<') || seen.has(href)) return;
      seen.add(href);
      const $card = climbToCard($el);
      items.push(item(site, {
        title,
        url: href,
        thumbnail: $card.find('img').attr('src') || '',
        duration: parseDuration($card.find('[data-role="video-duration"], [class*="duration"]').first().text()),
      }));
    });
    return { ok: true, items: dedupe(items) };
  },

  ted: async (site, q, limit, opts, page) => {
    const $ = await getHtml(searchUrlFor(site, q) + (page > 1 ? '&page=' + page : ''));
    const items = [];
    const seen = new Set();
    $('a[href*="/talks/"]').each((_i, el) => {
      if (items.length >= limit) return false;
      const $el = $(el);
      const href = ($el.attr('href') || '').split('?')[0];
      if (!/\/talks\/[a-z0-9_]+$/i.test(href) || seen.has(href)) return;
      seen.add(href);
      const slug = href.split('/talks/')[1] || '';
      const $card = climbToCard($el);
      items.push(item(site, {
        title: ($el.text() || '').trim() || slug.replace(/_/g, ' '),
        url: absolute('https://www.ted.com', href),
        thumbnail: $card.find('img').attr('src') || '',
        duration: parseDuration($card.find('[class*="duration"]').first().text()),
      }));
    });
    return { ok: true, items: dedupe(items) };
  },
};

// Result pages hang the title on a deeply nested <a> and the thumbnail on a
// sibling branch, so walk up until we reach the element holding both.
function climbToCard($el) {
  let $node = $el;
  for (let i = 0; i < 6; i++) {
    const $parent = $node.parent();
    if (!$parent || !$parent.length) break;
    $node = $parent;
    if ($node.find('img').length) break;
  }
  return $node;
}

// XVideos and XNXX serve the same markup, so one scraper covers both.
async function scrapeXTube(site, q, limit, page, base) {
  // Both sites take a 0-based page number: /?k=q&p=1 and /search/q/1.
  const first = searchUrlFor(site, q);
  const url = page > 1
    ? (first.includes('?') ? first + '&p=' + (page - 1) : first + '/' + (page - 1))
    : first;
  const $ = await getHtml(url);
  const items = [];
  $('div.thumb-block').each((_i, el) => {
    if (items.length >= limit) return false;
    const $el = $(el);
    const $a = $el.find('.thumb-under a[title]').first();
    const href = $a.attr('href') || $el.find('.thumb a').attr('href') || '';
    const title = ($a.attr('title') || $a.text() || '').replace(/\s+/g, ' ').trim();
    if (!href || !title) return;
    items.push(item(site, {
      title,
      url: absolute(base, href),
      thumbnail: $el.find('img').attr('data-src') || $el.find('img').attr('src') || '',
      duration: parseDuration($el.find('.metadata, .duration').first().text()),
    }));
  });
  return { ok: true, items: dedupe(items) };
}

// --------------------------------------------------------------- site list

// The catalog is the curated part; yt-dlp knows about ~1700 more extractors.
// Both go in the picker so the user can filter the whole supported set.
let extractorCache = null;
let extractorRefreshing = null;

// The extractor list costs a ~3.4s yt-dlp start-up but changes about as often
// as yt-dlp is updated, so it is cached on disk and refreshed in the
// background. The picker never waits on it.
function extractorCachePath(opts) {
  const dir = (opts && opts.cacheDir) || os.tmpdir();
  return path.join(dir, 'velox-extractors.json');
}

function readExtractorCache(opts) {
  if (extractorCache) return extractorCache;
  try {
    const raw = JSON.parse(fs.readFileSync(extractorCachePath(opts), 'utf-8'));
    if (Array.isArray(raw.list) && raw.list.length) {
      extractorCache = { list: raw.list, at: raw.at || 0 };
      return extractorCache;
    }
  } catch { /* no cache yet */ }
  return null;
}

function writeExtractorCache(list, opts) {
  extractorCache = { list, at: Date.now() };
  try {
    fs.writeFileSync(extractorCachePath(opts), JSON.stringify(extractorCache));
  } catch { /* cache is an optimisation, not a requirement */ }
}

async function refreshExtractorNames(opts) {
  if (extractorRefreshing) return extractorRefreshing;
  extractorRefreshing = (async () => {
    const r = await runYtdlp(['--color', 'never', '--list-extractors'], { ...opts, timeoutMs: 60000 });
    if (r.ok) {
      const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
      const list = r.out.replace(ansi, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (list.length) writeExtractorCache(list, opts);
    }
    extractorRefreshing = null;
    return extractorCache ? extractorCache.list : [];
  })();
  return extractorRefreshing;
}

// Returns whatever is cached right now, kicking off a refresh when stale.
function listExtractorNames(opts) {
  const cached = readExtractorCache(opts);
  const stale = !cached || Date.now() - cached.at > 7 * 24 * 3600 * 1000;
  if (stale) refreshExtractorNames(opts).catch(() => {});
  return cached ? cached.list : [];
}

function searchMode(site) {
  if (site.adapter) return 'adapter';
  if (site.s && site.s.includes('{q}')) return 'browser';
  return 'link';
}

// A yt-dlp extractor name is not a domain, so entries built from the raw list
// are link-only: the user pastes a URL and yt-dlp takes it from there.
function extractorEntry(name) {
  return {
    id: 'ytdlp:' + name.toLowerCase(),
    name,
    domain: '',
    cat: 'other',
    mode: 'link',
    nsfw: false,
  };
}

async function listSites(opts = {}) {
  const curated = SITES.map((s) => ({
    id: s.id, name: s.name, domain: s.domain, cat: s.cat,
    mode: searchMode(s), nsfw: !!s.nsfw,
  }));

  // yt-dlp names one site several ways ("10play", "10play:season") and rarely
  // matches our display name exactly ("10play (AU)"), so compare on a
  // squashed form and drop the qualifier in brackets.
  const squash = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
  const covered = new Set();
  curated.forEach((s) => {
    covered.add(squash(s.name));
    if (s.domain) covered.add(squash(s.domain.replace(/\.[a-z.]+$/, '')));
  });

  // Per-site variants ("PornHubUser", "YoutubeYtBe") are the same site under a
  // different entry point, so fold them into the curated entry too. The length
  // floor keeps short keys like "box" or "ign" from swallowing unrelated names.
  const prefixes = [...covered].filter((k) => k.length >= 5);
  const isCovered = (name) => {
    const key = squash(name.split(':')[0]);
    return covered.has(key) || prefixes.some((p) => key.startsWith(p));
  };

  const extras = listExtractorNames(opts)
    .filter((n) => !isCovered(n))
    .map(extractorEntry);

  return {
    ok: true,
    categories: CATEGORIES,
    sites: curated.concat(extras),
    counts: {
      total: curated.length + extras.length,
      curated: curated.length,
      adapter: curated.filter((s) => s.mode === 'adapter').length,
      browser: curated.filter((s) => s.mode === 'browser').length,
    },
  };
}

// ------------------------------------------------------------------ search

// Some sources are simply far away: a YouTube round trip is ~3.5s no matter
// how the request is shaped. So results are cached for a few minutes, and the
// next page is fetched in the background as soon as one is served — by the
// time the reader scrolls, it is usually already in hand.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 80;
const resultCache = new Map();

function cacheKey(siteId, query, limit, page, kind) {
  return [siteId, String(query).toLowerCase().trim(), limit, page, kind || 'video'].join('|');
}

function cachePut(key, entry) {
  if (resultCache.size > CACHE_MAX) {
    // Oldest first: Map keeps insertion order.
    const drop = resultCache.size - CACHE_MAX;
    let i = 0;
    for (const k of resultCache.keys()) { if (i++ >= drop) break; resultCache.delete(k); }
  }
  resultCache.set(key, entry);
}

// `page` is 1-based. The result carries `hasMore` so the Search tab knows
// whether scrolling further is worth another round trip.
async function searchSite(siteId, query, limit, opts = {}, page = 1, prefetched = false) {
  const n = clampLimit(limit);
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), 200);
  const key = cacheKey(siteId, query, n, p, opts.kind);

  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    const res = hit.promise ? await hit.promise : hit.res;
    if (res && res.ok && !prefetched) lookAhead(siteId, query, n, opts, p, res);
    return res;
  }

  const promise = runSearch(siteId, query, n, opts, p);
  cachePut(key, { at: Date.now(), promise });
  let res;
  try {
    res = await promise;
  } catch (err) {
    resultCache.delete(key);
    throw err;
  }
  cachePut(key, { at: Date.now(), res });
  if (res && res.ok && !prefetched) lookAhead(siteId, query, n, opts, p, res);
  return res;
}

// Warm the next page in the background. Never chains further than one page,
// so a single search can never spiral into a crawl of the whole site.
function lookAhead(siteId, query, limit, opts, page, res) {
  if (!res.hasMore || res.mode !== 'adapter' || page >= 200) return;
  const key = cacheKey(siteId, query, limit, page + 1);
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return;
  searchSite(siteId, query, limit, opts, page + 1, true).catch(() => {});
}

async function runSearch(siteId, query, limit, opts, page) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Type something to search for.' };

  const site = getSite(siteId);
  if (!site) {
    return {
      ok: false, mode: 'link',
      error: 'This site has no search page Velox can read. Paste a link from it into the URL box instead.',
    };
  }

  const n = limit;
  const p = page;
  const mode = searchMode(site);

  if (mode === 'browser' || mode === 'link') {
    return {
      ok: true, mode, site: site.name, page: p, hasMore: false,
      browseUrl: mode === 'browser' ? searchUrlFor(site, q) : site.home,
      items: [],
    };
  }

  const adapter = ADAPTERS[site.adapter];
  if (!adapter) return { ok: false, error: `No search handler for ${site.name}.` };
  if (!axios && site.adapter !== 'ytdlp-prefix' && site.adapter !== 'ytdlp-url') {
    return { ok: false, error: 'Network module missing; reinstall Velox.' };
  }

  try {
    const res = await adapter(site, q, n, opts, p);
    if (!res.ok) {
      return { ...res, mode: 'adapter', site: site.name, page: p, hasMore: false, browseUrl: searchUrlFor(site, q) };
    }
    const items = res.items.slice(0, n);
    return {
      ok: true, mode: 'adapter', site: site.name,
      items,
      page: p,
      // Optimistic: dedupe can make a full page look short, so keep going
      // while anything comes back. The caller stops when a page adds nothing.
      hasMore: items.length > 0 && p < 200,
      browseUrl: searchUrlFor(site, q),
    };
  } catch (err) {
    const status = err && err.response && err.response.status;
    return {
      ok: false, mode: 'adapter', site: site.name, page: p, hasMore: false,
      browseUrl: searchUrlFor(site, q),
      error: status
        ? `${site.name} refused the search (HTTP ${status}). Open it in the browser tab instead.`
        : `${site.name} search failed: ${String((err && err.message) || err).slice(0, 120)}`,
    };
  }
}



// Called once at start-up so the first click on the site picker never waits
// on yt-dlp, and so the SoundCloud client_id is already in hand.
function warmUp(opts = {}) {
  try { listExtractorNames(opts); } catch { /* best effort */ }
  soundcloudClientId().catch(() => {});
}

module.exports = { listSites, searchSite, searchUrlFor, getSite, warmUp };
