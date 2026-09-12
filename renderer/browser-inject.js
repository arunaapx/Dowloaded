// Runs inside every page shown in the Browser tab.
//
// This is the built-in equivalent of the Velox browser extension: it finds the
// video on the page and puts a Download button on top of it. It runs as a
// webview preload rather than an injected page script, because page CSP would
// block an injected <script> or <style> on most large sites. For the same
// reason every style here is set inline on the element instead of through a
// stylesheet.
const { ipcRenderer } = require('electron');

const MIN_W = 200;
const MIN_H = 120;

// On these sites the page URL is what yt-dlp wants; the <video> src is a blob
// or a short-lived CDN chunk that would not download on its own.
const PAGE_URL_HOSTS = [
  'youtube.com', 'youtu.be', 'music.youtube.com', 'facebook.com', 'fb.watch',
  'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'vimeo.com',
  'dailymotion.com', 'twitch.tv', 'soundcloud.com', 'reddit.com',
  'bitchute.com', 'odysee.com', 'nicovideo.jp', 'bilibili.com',
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'eporner.com',
];

const BTN_ID = '__velox_dl_btn';
const MENU_ID = '__velox_dl_menu';
const TOAST_ID = '__velox_dl_toast';

let target = null;      // the <video> the button is currently attached to
let button = null;
let menu = null;
let repositionQueued = false;

function host() {
  try { return location.hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

function usePageUrl() {
  const h = host();
  return PAGE_URL_HOSTS.some((k) => h === k || h.endsWith('.' + k));
}

// What should actually be handed to the downloader for this video.
function urlFor(video) {
  if (usePageUrl()) return location.href;
  const direct = (video && (video.currentSrc || video.src)) || '';
  if (direct && /^https?:/i.test(direct)) return direct;
  const source = video && video.querySelector && video.querySelector('source[src]');
  const fromSource = source && source.getAttribute('src');
  if (fromSource) {
    try { return new URL(fromSource, document.baseURI).href; } catch { /* ignore */ }
  }
  return location.href; // last resort: let yt-dlp read the page
}

function pageTitle() {
  return (document.title || '').trim().slice(0, 200);
}

// The biggest visible video on screen is the one the reader is watching.
function pickVideo() {
  let best = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) continue;
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }
  return best;
}

function style(el, props) {
  for (const k of Object.keys(props)) el.style.setProperty(k, props[k], 'important');
}

function makeButton() {
  const b = document.createElement('button');
  b.id = BTN_ID;
  b.type = 'button';
  b.textContent = '⬇  Download';
  style(b, {
    position: 'fixed',
    'z-index': '2147483647',
    display: 'none',
    'align-items': 'center',
    gap: '6px',
    padding: '8px 14px',
    border: '0',
    'border-radius': '999px',
    background: 'linear-gradient(135deg, #6cc4ff 0%, #4ea8ff 100%)',
    color: '#0c1220',
    font: '600 13px/1 system-ui, "Segoe UI", sans-serif',
    cursor: 'pointer',
    'box-shadow': '0 6px 20px rgba(0, 0, 0, 0.45)',
    opacity: '0.94',
  });
  b.addEventListener('mouseenter', () => style(b, { opacity: '1' }));
  b.addEventListener('mouseleave', () => style(b, { opacity: '0.94' }));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
  });
  return b;
}

const CHOICES = [
  { label: 'Video · Best', mode: 'video', quality: 'best' },
  { label: 'Video · 1080p', mode: 'video', quality: '1080p' },
  { label: 'Video · 720p', mode: 'video', quality: '720p' },
  { label: 'MP3 · 320 kbps', mode: 'audio', audioBitrate: '320' },
  { label: 'MP3 · 192 kbps', mode: 'audio', audioBitrate: '192' },
];

function makeMenu() {
  const m = document.createElement('div');
  m.id = MENU_ID;
  style(m, {
    position: 'fixed',
    'z-index': '2147483647',
    display: 'none',
    'flex-direction': 'column',
    padding: '6px',
    'border-radius': '10px',
    background: '#121826',
    border: '1px solid rgba(255,255,255,0.12)',
    'box-shadow': '0 16px 40px rgba(0,0,0,0.6)',
    'min-width': '170px',
  });
  for (const choice of CHOICES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = choice.label;
    style(item, {
      display: 'block',
      width: '100%',
      'text-align': 'left',
      padding: '8px 10px',
      border: '0',
      background: 'transparent',
      color: '#e6ebf3',
      font: '500 13px/1.2 system-ui, "Segoe UI", sans-serif',
      'border-radius': '6px',
      cursor: 'pointer',
    });
    item.addEventListener('mouseenter', () => style(item, { background: 'rgba(255,255,255,0.08)' }));
    item.addEventListener('mouseleave', () => style(item, { background: 'transparent' }));
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
      request(choice);
    });
    m.appendChild(item);
  }
  return m;
}

function toggleMenu() {
  if (!menu) return;
  if (menu.style.display === 'flex') { hideMenu(); return; }
  const r = button.getBoundingClientRect();
  style(menu, { display: 'flex' });
  const mr = menu.getBoundingClientRect();
  const top = r.bottom + 8 + mr.height > window.innerHeight ? r.top - mr.height - 8 : r.bottom + 8;
  style(menu, {
    top: Math.max(8, top) + 'px',
    left: Math.max(8, Math.min(r.right - mr.width, window.innerWidth - mr.width - 8)) + 'px',
  });
}

function hideMenu() {
  if (menu) style(menu, { display: 'none' });
}

function toast(text) {
  let t = document.getElementById(TOAST_ID);
  if (!t) {
    t = document.createElement('div');
    t.id = TOAST_ID;
    style(t, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      'z-index': '2147483647',
      padding: '10px 16px',
      'border-radius': '999px',
      background: '#121826',
      color: '#e6ebf3',
      border: '1px solid rgba(255,255,255,0.12)',
      font: '500 13px/1 system-ui, "Segoe UI", sans-serif',
      'box-shadow': '0 10px 30px rgba(0,0,0,0.5)',
    });
    document.documentElement.appendChild(t);
  }
  t.textContent = text;
  style(t, { display: 'block' });
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => style(t, { display: 'none' }), 2600);
}

function request(choice) {
  const url = urlFor(target);
  if (!url) { toast('Could not find a video on this page.'); return; }
  ipcRenderer.sendToHost('velox-download', {
    url,
    mode: choice.mode,
    quality: choice.quality || 'best',
    audioBitrate: choice.audioBitrate || '192',
    sourcePage: location.href,
    title: pageTitle(),
  });
  toast(choice.mode === 'audio' ? 'Sent to Velox as MP3' : 'Sent to Velox');
}

function place() {
  repositionQueued = false;
  if (!button) return;
  const video = pickVideo();
  target = video;
  if (!video) { style(button, { display: 'none' }); hideMenu(); return; }
  const r = video.getBoundingClientRect();
  style(button, {
    display: 'inline-flex',
    top: Math.max(8, r.top + 12) + 'px',
    left: Math.max(8, Math.min(r.right - 132, window.innerWidth - 140)) + 'px',
  });
}

function queuePlace() {
  if (repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(place);
}

// Every link on the page that points at a video page on a site Velox can read.
//
// Anchors, not <video> elements: a channel or search page holds dozens of links
// and usually plays nothing, which is exactly the page someone wants to take in
// one go. Media elements are what the single download button already handles.
function collectPageLinks() {
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href, location.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (!isPageUrlHost(u.hostname)) continue;
    // A watchable page, not a channel, a tag or the site's front door.
    const isVideo = u.searchParams.has('v')
      || /\/(watch|video|videos|shorts|embed|clip|status|reel|p)\//.test(u.pathname)
      || /^\/[A-Za-z0-9_-]{6,}$/.test(u.pathname);
    if (!isVideo) continue;
    // Tracking parameters make the same video look like several links.
    u.hash = '';
    for (const junk of ['list', 'index', 'pp', 'si', 't', 'start_radio', 'feature', 'ab_channel']) {
      u.searchParams.delete(junk);
    }
    const clean = u.toString();
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, title: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90) });
    if (out.length >= 300) break;   // a guard, not a preference
  }
  return out;
}

function isPageUrlHost(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  return PAGE_URL_HOSTS.some((k) => h === k || h.endsWith('.' + k));
}

function start() {
  if (window.__veloxBrowserInjected) return;
  window.__veloxBrowserInjected = true;

  button = makeButton();
  menu = makeMenu();
  // documentElement, not body: some sites replace body wholesale on navigation.
  document.documentElement.appendChild(button);
  document.documentElement.appendChild(menu);

  place();
  setInterval(queuePlace, 1200);          // catches SPA navigations and lazy players
  window.addEventListener('scroll', queuePlace, { passive: true });
  window.addEventListener('resize', queuePlace, { passive: true });
  document.addEventListener('click', (e) => {
    if (menu && !menu.contains(e.target) && e.target !== button) hideMenu();
  }, true);

  // Asked for by the toolbar button in the app, so the scan happens on demand
  // rather than on every page the user merely visits.
  ipcRenderer.on('velox-collect-links', () => {
    let links = [];
    try { links = collectPageLinks(); } catch (e) { links = []; }
    ipcRenderer.sendToHost('velox-page-links', { links, pageUrl: location.href, title: document.title });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
