(() => {
  if (window.__veloxInjected) return;
  window.__veloxInjected = true;

  const MIN_W = 180;
  const MIN_H = 110;
  const ATTR = 'data-velox-attached';
  const MAX_CANDIDATES = 80;

  const MEDIA_RE = /\.(?:m3u8|mpd|mp4|m4v|webm|mov|ts)(?:[?#]|$)/i;
  const MEDIA_HINT_RE = /(?:\/hls\/|\/dash\/|\/video\/|\/videos\/|\/videoplayback|mime=video|type=video)/i;
  const LOW_VALUE_RE = /(?:sprite|thumbnail|thumb|poster|preview|avatar|ads?|analytics|tracking)/i;
  const EXTRACTOR_HOSTS = [
    'youtube.com', 'youtu.be', 'facebook.com', 'fb.watch', 'instagram.com',
    'tiktok.com', 'x.com', 'twitter.com', 'vimeo.com', 'dailymotion.com',
    'twitch.tv', 'soundcloud.com', 'reddit.com', 'pornhub.com',
  ];

  const QUALITIES = [
    { label: 'Best available', mode: 'video', quality: 'best' },
    { label: '4K', mode: 'video', quality: '4k' },
    { label: '1080p', mode: 'video', quality: '1080p' },
    { label: '720p', mode: 'video', quality: '720p' },
    { label: '480p', mode: 'video', quality: '480p' },
    { sep: true },
    { label: 'MP3 320 kbps', mode: 'audio', audioBitrate: '320' },
    { label: 'MP3 192 kbps', mode: 'audio', audioBitrate: '192' },
  ];

  const candidates = new Map();
  const tracked = [];
  let toastEl = null;
  let pageButton = null;
  let scanTimer = null;
  let raf = false;

  function svg(name) {
    const icons = {
      down: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      check: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      spin: '<svg class="velox-spin" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="14 36" stroke-linecap="round"/></svg>',
      err: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 4v10M12 18v.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
    };
    return icons[name];
  }

  function absoluteUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const value = raw.trim().replace(/\\\//g, '/');
    if (!value || /^(?:data|blob|javascript|about|chrome|chrome-extension):/i.test(value)) return '';
    try {
      const parsed = new URL(value, document.baseURI);
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function hostFrom(url) {
    try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
    catch { return ''; }
  }

  function prefersPageUrl() {
    if (!isLikelyVideoPage()) return false;
    const host = hostFrom(location.href);
    return EXTRACTOR_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
  }

  function isLikelyVideoPage() {
    try {
      const url = new URL(location.href);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      const path = url.pathname;
      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        return (path === '/watch' && url.searchParams.has('v')) || path.startsWith('/shorts/');
      }
      if (host === 'youtu.be') return path.length > 1;
      if (host === 'pornhub.com' || host.endsWith('.pornhub.com')) {
        return path.includes('view_video') || url.searchParams.has('viewkey');
      }
      if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return /\/video\//.test(path);
      if (host === 'instagram.com' || host.endsWith('.instagram.com')) return /^\/(?:p|reel|tv)\//.test(path);
      if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) return /\/status\//.test(path);
      if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return /\/\d+/.test(path);
      if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com')) return /\/video\//.test(path);
      if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch') {
        return /\/(?:watch|videos|reel)\b|\/video\.php/.test(path) || host === 'fb.watch';
      }
      return !!document.querySelector('video');
    } catch {
      return false;
    }
  }

  function isThumbnailPreview(video) {
    const host = hostFrom(location.href);
    const inMainPlayer = !!video.closest('#movie_player, .html5-video-player, ytd-player, [data-velox-main-player]');
    if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && !inMainPlayer) {
      if (video.closest('ytd-thumbnail, ytd-rich-grid-media, ytd-compact-video-renderer, ytd-video-renderer, ytd-playlist-video-renderer, a#thumbnail')) {
        return true;
      }
    }

    const clickableCard = video.closest('a[href], ytd-thumbnail, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, [role="listitem"]');
    const rect = video.getBoundingClientRect?.();
    if (clickableCard && rect && rect.width < 520 && rect.height < 320 && !inMainPlayer) return true;
    return false;
  }

  function shouldAttach(video) {
    if (!video || video.hasAttribute(ATTR)) return false;
    if (isThumbnailPreview(video)) return false;
    const rect = video.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.width >= MIN_W && rect.height >= MIN_H;
  }

  function looksLikeMedia(url, force) {
    return !!force || MEDIA_RE.test(url) || MEDIA_HINT_RE.test(url);
  }

  function mediaType(url) {
    if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'HLS';
    if (/\.mpd(?:[?#]|$)/i.test(url)) return 'DASH';
    if (/\.mp4(?:[?#]|$)/i.test(url)) return 'MP4';
    if (/\.webm(?:[?#]|$)/i.test(url)) return 'WEBM';
    if (/\.m4v(?:[?#]|$)/i.test(url)) return 'M4V';
    return 'Video';
  }

  function scoreUrl(url, meta = {}) {
    let score = Number(meta.score) || 0;
    if (/\.m3u8(?:[?#]|$)/i.test(url)) score += 80;
    else if (/\.mpd(?:[?#]|$)/i.test(url)) score += 76;
    else if (/\.mp4(?:[?#]|$)/i.test(url)) score += 72;
    else if (/\.webm(?:[?#]|$)/i.test(url)) score += 66;
    else if (MEDIA_HINT_RE.test(url)) score += 50;

    if (meta.source === 'video-tag' || meta.source === 'source-tag') score += 24;
    if (meta.source === 'network' || meta.source === 'fetch' || meta.source === 'xhr') score += 18;
    if (meta.source === 'meta') score += 12;
    if (meta.source === 'link') score += 8;

    const res = String(url).match(/(?:^|[^\d])(2160|1440|1080|720|480|360)p?/i);
    if (res) score += Math.min(30, Number(res[1]) / 80);
    if (LOW_VALUE_RE.test(url)) score -= 36;
    return score;
  }

  function trimCandidates() {
    if (candidates.size <= MAX_CANDIDATES) return;
    const sorted = sortedCandidates();
    candidates.clear();
    for (const item of sorted.slice(0, MAX_CANDIDATES)) candidates.set(item.url, item);
  }

  function addCandidate(rawUrl, meta = {}) {
    const url = absoluteUrl(rawUrl);
    if (!url || !looksLikeMedia(url, meta.force)) return null;

    const existing = candidates.get(url);
    const score = scoreUrl(url, meta);
    const next = {
      ...(existing || {}),
      url,
      type: mediaType(url),
      source: meta.source || existing?.source || 'detected',
      title: meta.title || existing?.title || document.title || hostFrom(url),
      referer: meta.referer || existing?.referer || location.href,
      sourcePage: location.href,
      score: Math.max(score, existing?.score || 0),
      seenAt: Date.now(),
      width: meta.width || existing?.width || 0,
      height: meta.height || existing?.height || 0,
    };
    candidates.set(url, next);
    trimCandidates();
    updatePageButton();
    return next;
  }

  function addPageCandidate(meta = {}) {
    if (!prefersPageUrl()) return null;
    return addCandidate(location.href, {
      ...meta,
      force: true,
      source: 'site-extractor',
      score: 95,
      title: document.title || hostFrom(location.href),
    });
  }

  function sortedCandidates() {
    return [...candidates.values()]
      .sort((a, b) => (b.score - a.score) || (b.seenAt - a.seenAt));
  }

  function bestCandidate() {
    return sortedCandidates()[0] || addPageCandidate({ score: 20 });
  }

  function scanMediaElement(el) {
    const rect = el.getBoundingClientRect?.();
    const meta = {
      source: el.tagName === 'SOURCE' ? 'source-tag' : 'video-tag',
      title: el.getAttribute('title') || document.title || '',
      width: rect?.width || el.videoWidth || 0,
      height: rect?.height || el.videoHeight || 0,
      score: 16,
    };
    addCandidate(el.currentSrc || el.src || el.getAttribute('src'), meta);
    el.querySelectorAll?.('source[src]').forEach((source) => {
      addCandidate(source.src || source.getAttribute('src'), { ...meta, source: 'source-tag' });
    });
    if ((el.tagName || '').toLowerCase() === 'video') addPageCandidate({ score: 30 });
  }

  function bestForVideo(video) {
    scanMediaElement(video);
    const urls = [
      video.currentSrc,
      video.src,
      ...[...video.querySelectorAll('source[src]')].map((source) => source.src || source.getAttribute('src')),
    ].map(absoluteUrl).filter(Boolean);

    for (const url of urls) {
      const hit = candidates.get(url);
      if (hit) return hit;
    }
    return bestCandidate();
  }

  function payloadFor(target, option) {
    const candidate = target?.tagName ? bestForVideo(target) : bestCandidate();
    const usePage = prefersPageUrl() || !candidate?.url;
    const url = usePage ? location.href : candidate.url;
    return {
      url,
      mode: option.mode || 'video',
      quality: option.quality || '1080p',
      audioBitrate: option.audioBitrate || '192',
      referer: url === location.href ? '' : location.href,
      sourcePage: location.href,
      detectedUrl: candidate?.url || '',
      title: candidate?.title || document.title || hostFrom(location.href),
    };
  }

  function payloadForCandidate(candidate, option) {
    const item = candidate || bestCandidate();
    const url = item?.url || location.href;
    return {
      url,
      mode: option.mode || 'video',
      quality: option.quality || 'best',
      audioBitrate: option.audioBitrate || '192',
      referer: url === location.href ? '' : location.href,
      sourcePage: location.href,
      detectedUrl: item?.url || '',
      title: item?.title || document.title || hostFrom(location.href),
    };
  }

  function displayTitle(item) {
    return (item?.title || item?.type || 'Detected video').replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  function displayMeta(item) {
    const bits = [item?.type || 'Video', item?.source || 'detected', hostFrom(item?.url || '')].filter(Boolean);
    if (item?.width && item?.height) bits.unshift(`${Math.round(item.width)}x${Math.round(item.height)}`);
    return bits.join(' · ');
  }

  function qualityMenuHtml() {
    return QUALITIES.map((q) =>
      q.sep
        ? '<div class="velox-sep"></div>'
        : `<button class="velox-mi" data-mode="${q.mode}"${q.quality ? ` data-quality="${q.quality}"` : ''}${q.audioBitrate ? ` data-audio="${q.audioBitrate}"` : ''}>
             <span class="velox-mi-ico">${q.mode === 'audio' ? 'Audio' : 'Video'}</span>
             <span class="velox-mi-label">${q.label}</span>
           </button>`
    ).join('');
  }

  function buildButton(label = 'Download', variant = 'video') {
    const wrap = document.createElement('div');
    wrap.className = 'velox-dl-btn';
    const menu = variant === 'page'
      ? `
        <div class="velox-detected-head">
          <span>Detected videos</span>
          <span class="velox-detected-total">Scanning</span>
        </div>
        <div class="velox-detected-list">
          <div class="velox-detected-empty">Scanning this page...</div>
        </div>
        <div class="velox-sep"></div>
        <div class="velox-menu-caption">Quick actions for best match</div>
        ${qualityMenuHtml()}
      `
      : qualityMenuHtml();
    wrap.innerHTML = `
      <div class="velox-pill" role="button" aria-label="Download with Velox" title="Download with Velox">
        <span class="velox-icon-slot">${svg('down')}</span>
        <span class="velox-label">${label}</span>
        <span class="velox-count"></span>
        <span class="velox-caret">v</span>
      </div>
      <div class="velox-menu" role="menu">
        ${menu}
      </div>
    `;
    document.body.appendChild(wrap);
    return wrap;
  }

  function send(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'velox-send', payload }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  function showToast(text, kind = 'ok') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'velox-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.className = `velox-toast velox-toast-${kind} velox-toast-show`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('velox-toast-show'), 2200);
  }

  function setState(btn, state) {
    const slot = btn.querySelector('.velox-icon-slot');
    const label = btn.querySelector('.velox-label');
    btn.classList.remove('velox-loading', 'velox-success', 'velox-error');
    if (state === 'loading') {
      btn.classList.add('velox-loading');
      slot.innerHTML = svg('spin');
      label.textContent = 'Sending';
    } else if (state === 'success') {
      btn.classList.add('velox-success');
      slot.innerHTML = svg('check');
      label.textContent = 'Sent';
    } else if (state === 'error') {
      btn.classList.add('velox-error');
      slot.innerHTML = svg('err');
      label.textContent = 'Failed';
    } else {
      slot.innerHTML = svg('down');
      label.textContent = btn.classList.contains('velox-page-btn') ? 'Velox' : 'Download';
    }
  }

  function bindButton(btn, getTarget) {
    const pill = btn.querySelector('.velox-pill');
    const menu = btn.querySelector('.velox-menu');

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.classList.toggle('velox-open');
    });

    menu.addEventListener('click', async (e) => {
      const row = e.target.closest('.velox-detected-row');
      if (row) {
        e.stopPropagation();
        e.preventDefault();
        btn.classList.remove('velox-open');
        const candidate = candidates.get(row.dataset.url);
        await sendFromButton(btn, payloadForCandidate(candidate, { mode: 'video', quality: 'best' }), row.querySelector('.velox-detected-title')?.textContent || 'Detected video');
        return;
      }

      const mi = e.target.closest('.velox-mi');
      if (!mi) return;
      e.stopPropagation();
      e.preventDefault();
      btn.classList.remove('velox-open');

      const option = {
        mode: mi.dataset.mode || 'video',
        quality: mi.dataset.quality || '1080p',
        audioBitrate: mi.dataset.audio || '192',
      };
      const payload = payloadFor(getTarget(), option);
      await sendFromButton(btn, payload, mi.querySelector('.velox-mi-label').textContent);
    });
  }

  async function sendFromButton(btn, payload, label) {
    setState(btn, 'loading');
    const result = await send(payload);
    if (result.ok) {
      setState(btn, 'success');
      showToast(`Sent to Velox: ${label}`, 'ok');
    } else {
      setState(btn, 'error');
      showToast(result.error?.includes('runtime') ? 'Reload the extension' : 'Velox app not running', 'err');
    }
    setTimeout(() => setState(btn, 'idle'), 2000);
  }

  function attach(video) {
    if (!shouldAttach(video)) {
      scanMediaElement(video);
      return;
    }
    video.setAttribute(ATTR, '1');
    scanMediaElement(video);

    const btn = buildButton('Download');
    bindButton(btn, () => video);

    let hideTimer = null;
    function reveal() {
      clearTimeout(hideTimer);
      btn.classList.add('velox-visible');
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!btn.classList.contains('velox-open')) btn.classList.remove('velox-visible');
      }, 1200);
    }
    video.addEventListener('mouseenter', reveal);
    video.addEventListener('mousemove', reveal);
    video.addEventListener('loadedmetadata', () => { scanMediaElement(video); schedule(); });
    video.addEventListener('play', () => { scanMediaElement(video); schedule(); });
    video.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('mouseenter', reveal);
    btn.addEventListener('mouseleave', scheduleHide);

    tracked.push({ video, btn });
  }

  function updatePageButton() {
    const count = sortedCandidates().length;
    if (!count && !document.querySelector('video,audio')) return;
    if (!pageButton) {
      pageButton = buildButton('Velox', 'page');
      pageButton.classList.add('velox-page-btn', 'velox-visible');
      bindButton(pageButton, () => null);
    }
    const countEl = pageButton.querySelector('.velox-count');
    if (countEl) countEl.textContent = count ? String(Math.min(count, 99)) : '';
    renderPageCandidateList();
  }

  function renderPageCandidateList() {
    if (!pageButton) return;
    const list = pageButton.querySelector('.velox-detected-list');
    const total = pageButton.querySelector('.velox-detected-total');
    if (!list) return;

    const items = sortedCandidates().slice(0, 10);
    if (total) total.textContent = items.length ? `${items.length} found` : 'None';
    list.textContent = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'velox-detected-empty';
      empty.textContent = 'No direct media found yet.';
      list.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement('button');
      row.className = 'velox-detected-row';
      row.type = 'button';
      row.dataset.url = item.url;
      row.title = item.url;

      const top = document.createElement('span');
      top.className = 'velox-detected-title';
      top.textContent = displayTitle(item);

      const meta = document.createElement('span');
      meta.className = 'velox-detected-meta';
      meta.textContent = displayMeta(item);

      row.append(top, meta);
      list.appendChild(row);
    }
  }

  function scanStaticCandidates() {
    addPageCandidate({ score: 25 });

    document.querySelectorAll('video,audio,source[src]').forEach(scanMediaElement);

    document.querySelectorAll('meta[property*="video"], meta[name*="video"], meta[property="og:url"], link[type*="video"], link[href]').forEach((el) => {
      const raw = el.content || el.href || el.getAttribute('content') || el.getAttribute('href');
      addCandidate(raw, { source: 'meta', score: 10 });
    });

    document.querySelectorAll('a[href], [src], [data-src], [data-video-src], [data-url], [data-m3u8], [data-hls], [data-mp4]').forEach((el) => {
      ['href', 'src', 'data-src', 'data-video-src', 'data-url', 'data-m3u8', 'data-hls', 'data-mp4'].forEach((attr) => {
        const raw = el.getAttribute?.(attr);
        if (raw) addCandidate(raw, { source: attr === 'href' ? 'link' : 'attribute', score: 6 });
      });
    });

    scanPerformance();
    scanScripts();
    updatePageButton();
  }

  function extractUrlsFromText(text, source) {
    if (!text || typeof text !== 'string') return;
    const normalized = text.replace(/\\\//g, '/');
    const re = /https?:\/\/[^\s"'<>\\]+/gi;
    let match;
    while ((match = re.exec(normalized))) {
      addCandidate(match[0], { source, score: 8 });
    }
  }

  function scanScripts() {
    const scripts = [...document.scripts].slice(-80);
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.length > 250000) continue;
      if (/m3u8|mpd|mp4|webm|videoplayback|hls|dash/i.test(text)) {
        extractUrlsFromText(text, 'script');
      }
    }
  }

  function scanPerformance() {
    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        addCandidate(entry.name, { source: 'network', score: 14 });
      });
    } catch {}
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scan();
      scanStaticCandidates();
      schedule();
    }, 250);
  }

  function scan() {
    document.querySelectorAll('video').forEach((video) => {
      if (shouldAttach(video)) attach(video);
      else scanMediaElement(video);
    });
    document.querySelectorAll('audio').forEach(scanMediaElement);
  }

  function position() {
    for (let i = tracked.length - 1; i >= 0; i--) {
      const { video, btn } = tracked[i];
      if (!document.contains(video)) {
        btn.remove();
        tracked.splice(i, 1);
        continue;
      }
      const r = video.getBoundingClientRect();
      const big = r.width >= MIN_W && r.height >= MIN_H;
      const onScreen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      if (!big || !onScreen) {
        btn.style.display = 'none';
        btn.classList.remove('velox-open', 'velox-visible');
        continue;
      }
      btn.style.display = '';
      const top = Math.max(8, r.top + 12);
      const right = Math.max(8, innerWidth - r.right + 12);
      btn.style.top = `${top}px`;
      btn.style.right = `${right}px`;
    }
  }

  function schedule() {
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => {
      raf = false;
      position();
    });
  }

  function injectNetworkHook() {
    try {
      if (!/^https?:$/i.test(location.protocol)) return;
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('page-hook.js');
      script.async = false;
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'velox-page-hook') return;
    addCandidate(event.data.url, { source: event.data.via || 'network', score: 18 });
  });

  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        addCandidate(entry.name, { source: 'network', score: 14 });
      }
    });
    po.observe({ entryTypes: ['resource'] });
  } catch {}

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'velox-get-candidates') {
      scanStaticCandidates();
      sendResponse({
        ok: true,
        pageUrl: location.href,
        candidates: sortedCandidates().slice(0, 12),
        prefersPageUrl: prefersPageUrl(),
      });
      return true;
    }
    return false;
  });

  document.addEventListener('click', (e) => {
    document.querySelectorAll('.velox-dl-btn.velox-open').forEach((btn) => {
      if (!btn.contains(e.target)) btn.classList.remove('velox-open');
    });
  });

  injectNetworkHook();
  scanStaticCandidates();
  schedule();

  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-src', 'data-video-src', 'data-url'] });

  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule);
  setInterval(() => { scanStaticCandidates(); schedule(); }, 1400);

  console.log('[Velox] high-accuracy detector active');
})();
