// Premium Features: Torrents, Games, Customization, Audio Notifications

document.addEventListener('DOMContentLoaded', () => {
  const notificationSound = document.getElementById('notificationSound');
  const addTorrentBtn = document.getElementById('addTorrentBtn');
  const torrentInput = document.getElementById('torrentInput');
  const torrentGrid = document.getElementById('torrentGrid');
  const refreshGamesBtn = document.getElementById('refreshGamesBtn');
  const gamesStatus = document.getElementById('gamesStatus');
  const gamesResults = document.getElementById('gamesResults');

  // ---- Search tab: which site are we searching? --------------------------
  const searchBtn = document.getElementById('searchBtn');
  const searchSiteFilterBtn = document.getElementById('searchSiteFilterBtn');
  const searchSiteFilterText = document.getElementById('searchSiteFilterText');
  const searchSiteMode = document.getElementById('searchSiteMode');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const searchStatus = document.getElementById('searchStatus');

  const supportedSitesModal = document.getElementById('supportedSitesModal');
  const supportedSitesClose = document.getElementById('supportedSitesClose');
  const supportedSitesList = document.getElementById('supportedSitesList');
  const supportedSitesSearch = document.getElementById('supportedSitesSearch');
  const supportedSitesCount = document.getElementById('supportedSitesCount');
  const supportedSitesCats = document.getElementById('supportedSitesCats');
  const supportedSitesNsfw = document.getElementById('supportedSitesNsfw');

  // The site is always the user's choice — there is no auto-detect fallback.
  // Until one is picked the search button sends them to the picker.
  const NO_SITE = { id: '__none', name: 'Select a site…', cat: 'all', mode: 'none' };
  // The one picker entry that is not a site: the torrent trackers.
  const TORRENT_SITE = { id: '__torrents', name: 'Torrents (Global)', cat: 'all', mode: 'torrents' };
  const SITE_MEMORY_KEY = 'velox.searchSite';

  // How a site can be searched, straight from core/site-search.js:
  //   adapter → real results inside Velox
  //   browser → open the site's own search page in the browser tab
  //   link    → yt-dlp supports it, but there is no search entry point
  const MODE_LABEL = {
    torrents: 'Trackers',
    adapter: 'Direct', browser: 'Browser', link: 'Paste link',
  };
  const MODE_CLASS = {
    torrents: 'mode-browser',
    adapter: 'mode-direct', browser: 'mode-browser', link: 'mode-link',
  };
  const MODE_DOT = { adapter: 'dot-direct', browser: 'dot-browser', link: 'dot-link' };

  let siteCatalog = null;
  let activeCategory = 'all';
  let showNsfw = false;
  let selectedSite = NO_SITE;
  // 'video' or 'playlist'. Only YouTube answers playlist searches, so the
  // toggle is hidden for every other site rather than offering a mode that
  // would silently return nothing.
  let searchKind = 'video';

  // Declared up here, with everything else setSelectedSite touches. Further
  // down it was still in the temporal dead zone when restoreSite() ran during
  // start-up, and the ReferenceError that threw took the rest of this module's
  // wiring with it - which is why clicking a site in the picker did nothing.
  const PLAYLIST_SITES = new Set(['youtube']);

  function setSelectedSite(site, remember) {
    selectedSite = site;
    refreshKindToggle();
    if (searchSiteFilterText) searchSiteFilterText.textContent = site.name;
    if (searchSiteFilterBtn) searchSiteFilterBtn.classList.toggle('unset', site.mode === 'none');
    if (searchInput) {
      searchInput.placeholder = site.mode === 'none'
        ? 'Pick a site first, then search…'
        : `Search ${site.name}…`;
    }
    if (remember !== false) rememberSite(site);

    if (!searchSiteMode) return;
    const label = MODE_LABEL[site.mode] || '';
    searchSiteMode.textContent = label;
    searchSiteMode.className = 'site-mode-badge ' + (MODE_CLASS[site.mode] || '');
    searchSiteMode.classList.toggle('hidden', !label);
  }

  // Remember the choice so the picker is a one-time step, not a per-search one.
  function rememberSite(site) {
    try {
      if (site.mode === 'none') localStorage.removeItem(SITE_MEMORY_KEY);
      else localStorage.setItem(SITE_MEMORY_KEY, JSON.stringify(site));
    } catch (e) { /* storage disabled; the choice just won't persist */ }
  }

  function restoreSite() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SITE_MEMORY_KEY) || 'null'); } catch (e) { saved = null; }
    setSelectedSite(saved && saved.id && saved.mode ? saved : NO_SITE, false);
  }

  async function loadSiteCatalog() {
    if (siteCatalog) return siteCatalog;
    const res = await window.api.siteList();
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not load the site list.');
    siteCatalog = res;
    return siteCatalog;
  }

  function categoryName(id) {
    const cats = (siteCatalog && siteCatalog.categories) || [];
    const hit = cats.find((c) => c.id === id);
    return hit ? hit.name : id;
  }

  function visibleSites() {
    if (!siteCatalog) return [];
    const q = (supportedSitesSearch ? supportedSitesSearch.value : '').toLowerCase().trim();
    return siteCatalog.sites.filter((s) => {
      if (s.nsfw && !showNsfw) return false;
      if (activeCategory !== 'all' && s.cat !== activeCategory) return false;
      if (q && !s.name.toLowerCase().includes(q) && !(s.domain || '').includes(q)) return false;
      return true;
    });
  }

  function renderCategories() {
    if (!supportedSitesCats || !siteCatalog) return;
    supportedSitesCats.innerHTML = '';
    siteCatalog.categories.forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cat.name;
      if (cat.id === activeCategory) btn.classList.add('active');
      btn.addEventListener('click', () => {
        activeCategory = cat.id;
        renderCategories();
        renderSiteList();
      });
      supportedSitesCats.appendChild(btn);
    });
  }

  function siteButton(site, isSpecial) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'site-picker-item' + (isSpecial ? ' special' : '');
    if (site.id === selectedSite.id) btn.classList.add('selected');

    const dot = document.createElement('i');
    dot.className = 'dot ' + (MODE_DOT[site.mode] || '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = site.name;
    btn.appendChild(dot);
    btn.appendChild(name);

    if (!isSpecial) {
      const cat = document.createElement('span');
      cat.className = 'cat';
      cat.textContent = site.cat === 'other' ? 'Velox' : categoryName(site.cat).split(' ')[0];
      btn.appendChild(cat);
      btn.title = `${site.name}${site.domain ? ' · ' + site.domain : ''} — ${MODE_LABEL[site.mode] || ''}`;
    }

    btn.addEventListener('click', () => {
      setSelectedSite(site);
      supportedSitesModal.classList.add('hidden');
      if (searchInput && (searchInput.value || '').trim()) runVeloxSearch();
      else if (searchInput) searchInput.focus();
    });
    return btn;
  }

  function renderSiteList() {
    if (!supportedSitesList) return;
    supportedSitesList.innerHTML = '';

    const showSpecials = activeCategory === 'all'
      && !(supportedSitesSearch && supportedSitesSearch.value.trim());
    if (showSpecials) {
      supportedSitesList.appendChild(siteButton(TORRENT_SITE, true));
    }

    const list = visibleSites();
    if (!list.length && !showSpecials) {
      const empty = document.createElement('div');
      empty.className = 'site-picker-empty';
      empty.textContent = 'No sites match that filter.';
      supportedSitesList.appendChild(empty);
    }
    // Long lists (yt-dlp knows ~1700 extractors) would stall the modal, so
    // render a page at a time and grow it as the user scrolls.
    renderChunk(list, 0);

    if (supportedSitesCount) {
      const direct = list.filter((s) => s.mode === 'adapter').length;
      supportedSitesCount.textContent = `${list.length} sites · ${direct} searchable in Velox`;
    }
  }

  function renderChunk(list, start) {
    const slice = list.slice(start, start + 120);
    slice.forEach((s) => supportedSitesList.appendChild(siteButton(s, false)));
    const next = start + slice.length;
    if (next < list.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'site-picker-item';
      more.textContent = `Show ${Math.min(120, list.length - next)} more…`;
      more.addEventListener('click', () => {
        more.remove();
        renderChunk(list, next);
      });
      supportedSitesList.appendChild(more);
    }
  }

  if (searchSiteFilterBtn) {
    searchSiteFilterBtn.addEventListener('click', () => openSitePicker());
  }

  async function openSitePicker() {
    if (!supportedSitesModal) return;
    supportedSitesModal.classList.remove('hidden');
    if (!siteCatalog) {
      supportedSitesList.innerHTML = '<div class="site-picker-empty">Loading the supported-site list…</div>';
      try {
        await loadSiteCatalog();
      } catch (err) {
        supportedSitesList.innerHTML = `<div class="site-picker-empty">${escapeHtmlPF(err.message)}</div>`;
        return;
      }
    }
    renderCategories();
    renderSiteList();
    if (supportedSitesSearch) supportedSitesSearch.focus();
  }

  if (supportedSitesClose) {
    supportedSitesClose.addEventListener('click', () => supportedSitesModal.classList.add('hidden'));
  }
  if (supportedSitesModal) {
    supportedSitesModal.addEventListener('click', (e) => {
      if (e.target === supportedSitesModal) supportedSitesModal.classList.add('hidden');
    });
  }
  if (supportedSitesSearch) {
    supportedSitesSearch.addEventListener('input', () => renderSiteList());
  }
  if (supportedSitesNsfw) {
    supportedSitesNsfw.addEventListener('change', () => {
      showNsfw = supportedSitesNsfw.checked;
      renderSiteList();
    });
  }

  function escapeHtmlPF(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  restoreSite();

  initKindToggle();

  // Server connection simulation to make it look premium/secure
  async function simulateServerLoad(textElement, finalLoadingText) {
    const stages = [
      "Establishing secure connection to Velox Core Servers...",
      "Authenticating client credentials...",
      "Routing through encrypted nodes...",
      "Querying distributed databases...",
      "Receiving secured payload..."
    ];
    for (const stage of stages) {
      if (!textElement || !textElement.offsetParent) break; // element hidden
      textElement.textContent = stage;
      await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
    }
    textElement.textContent = finalLoadingText;
  }

  // ---- One entry point for every kind of search --------------------------
  //
  // Capture phase, because app.js also binds the button and the Enter key for
  // the old YouTube-only search. Everything now routes through here instead.

  let searchToken = 0;

  // Infinite-scroll state for the result list.
  const PAGE_SIZE = 25;
  const renderedUrls = new Set();
  let feed = null;

  function refreshKindToggle() {
    const wrap = document.getElementById('searchKindWrap');
    if (!wrap) return;
    const supported = PLAYLIST_SITES.has(selectedSite && selectedSite.id);
    wrap.hidden = !supported;
    if (!supported && searchKind !== 'video') {
      searchKind = 'video';
      syncKindButtons();
    }
  }

  function syncKindButtons() {
    document.querySelectorAll('#searchKindWrap .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.kind === searchKind);
    });
  }

  function initKindToggle() {
    const wrap = document.getElementById('searchKindWrap');
    if (!wrap) return;
    wrap.querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        if (searchKind === b.dataset.kind) return;
        searchKind = b.dataset.kind;
        syncKindButtons();
        // Re-run rather than leave video results under a Playlists tab.
        if (searchInput && searchInput.value.trim()) runVeloxSearch();
      });
    });
    syncKindButtons();
    refreshKindToggle();
  }
  let feedObserver = null;
  let sentinel = null;

  if (searchBtn) {
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      runVeloxSearch();
    }, true);
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      runVeloxSearch();
    }, true);
  }

  // A yt-dlp search can take the better part of ten seconds. Without motion on
  // screen the tab reads as frozen, so a search shows an animated status line
  // and placeholder rows until the real results land.
  function setStatus(text, isError, isLoading) {
    if (!searchStatus) return;
    searchStatus.className = 'search-status'
      + (isError ? ' error' : '')
      + (isLoading ? ' searching' : '');
    searchStatus.style.display = text ? 'block' : 'none';
    searchStatus.textContent = text || '';
    if (!isLoading) clearSkeletons();
  }

  function showSkeletons(count) {
    clearSkeletons();
    for (let i = 0; i < (count || 4); i++) {
      const row = document.createElement('div');
      row.className = 'search-skeleton';
      row.innerHTML = '<div class="sk-thumb"></div><div class="sk-lines"><div class="sk-line"></div><div class="sk-line short"></div></div>';
      searchResults.appendChild(row);
    }
  }

  function clearSkeletons() {
    if (!searchResults) return;
    searchResults.querySelectorAll('.search-skeleton').forEach((el) => el.remove());
  }

  async function runVeloxSearch() {
    const query = (searchInput.value || '').trim();
    if (!query) { setStatus(''); return; }

    const isUrl = /^https?:\/\//i.test(query);

    // A plain query needs a site. A pasted link does not — yt-dlp works out
    // the site from the URL itself.
    if (!isUrl && selectedSite.mode === 'none') {
      stopFeed();
      renderedUrls.clear();
      searchResults.innerHTML = '';
      refreshBulkBar();
      setStatus('Choose a site to search first.', true);
      openSitePicker();
      return;
    }

    const token = ++searchToken;
    stopFeed();
    renderedUrls.clear();
    searchResults.innerHTML = '';
    refreshBulkBar();
    setStatus('Searching…', false, true);
    showSkeletons();
    searchBtn.disabled = true;

    try {
      if (isUrl) await searchByUrl(query, token);
      else if (selectedSite.mode === 'torrents') await searchTorrents(query, token);
      else await searchOneSite(query, token);
    } catch (err) {
      if (token === searchToken) setStatus(`Search failed: ${(err && err.message) || err}`, true);
    } finally {
      if (token === searchToken) searchBtn.disabled = false;
    }
  }

  // ---- Result rendering ---------------------------------------------------

  // Returns false when the item was already on screen, so paging can tell a
  // genuinely exhausted source from one that keeps replaying the same page.
  function renderMediaResult(r) {
    if (!r || !r.url || renderedUrls.has(r.url)) return false;
    renderedUrls.add(r.url);

    const div = document.createElement('div');
    div.className = 'search-item' + (r.isPlaylist ? ' playlist-item' : '');
    div.veloxItem = r;
    const sub = r.isPlaylist
      ? [r.uploader, 'Playlist'].filter(Boolean).join(' · ')
      : [r.uploader, r.duration ? formatDuration(r.duration) : '', r.site].filter(Boolean).join(' · ');

    div.innerHTML = `
      ${r.isPlaylist
        ? '<span class="res-pick res-pick-empty" aria-hidden="true"></span>'
        : '<label class="res-pick" title="Select for bulk download"><input type="checkbox" class="pick-box" /></label>'}
      <button class="res-thumb ${r.isPlaylist ? 'res-open' : 'res-play'}" type="button" title="${r.isPlaylist ? 'See what is in it' : 'Preview'}">
        ${r.thumbnail ? `<img src="${escapeHtmlPF(r.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>` : ''}
        <span class="play-badge">${r.isPlaylist
          ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm13-3l6 4-6 4z"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}</span>
      </button>
      <div class="res-info">
        <div class="res-title">${escapeHtmlPF(r.title)}</div>
        <div class="res-sub">${escapeHtmlPF(sub)}</div>
      </div>
      <div class="res-actions">
        ${r.isPlaylist
          ? '<button class="primary-btn sm open-playlist">Open playlist</button>'
          : '<button class="ghost-btn add-video">Video</button><button class="ghost-btn add-audio">MP3</button>'}
      </div>
    `;

    if (r.isPlaylist) {
      const open = () => {
        // The picker opens straight away in its reading state: the Start
        // button's label is the only other feedback there is, and it is on a
        // different tab from here.
        if (typeof maybeOpenPlaylist === 'function') maybeOpenPlaylist(r.url, { loader: true, title: r.title });
      };
      div.querySelector('.open-playlist').addEventListener('click', open);
      div.querySelector('.res-open').addEventListener('click', open);
    } else {
      div.querySelector('.add-video').addEventListener('click', () => sendToDownloader(r.url, 'video'));
      div.querySelector('.add-audio').addEventListener('click', () => sendToDownloader(r.url, 'audio'));
      div.querySelector('.pick-box').addEventListener('change', (e) => {
        div.classList.toggle('picked', e.target.checked);
        refreshBulkBar();
      });
      div.querySelector('.res-play').addEventListener('click', () => openPreview(r));
    }
    searchResults.appendChild(div);
    refreshBulkBar();
    return true;
  }

  // Named apart from app.js's queueDownload: declaring another function of
  // that name in here shadowed it, and the bulk queue silently sent an object
  // where the mode should have been.
  function sendToDownloader(url, mode) {
    openTab('new');
    document.getElementById('urlInput').value = url;
    switchMode(mode);
    startDownload();
  }

  // ---- Preview player -----------------------------------------------------
  //
  // Plays a result before downloading it. Sites with a documented embed player
  // get that; everything else loads its own watch page. The player lives in a
  // <webview>, which runs in its own process, and is destroyed on close so the
  // audio actually stops.

  const previewModal = document.getElementById('previewModal');
  const previewStage = document.getElementById('previewStage');
  const previewTitle = document.getElementById('previewTitle');
  const previewSite = document.getElementById('previewSite');
  const previewClose = document.getElementById('previewClose');
  const previewVideoBtn = document.getElementById('previewVideoBtn');
  const previewAudioBtn = document.getElementById('previewAudioBtn');
  const previewOpenBtn = document.getElementById('previewOpenBtn');

  let previewItem = null;

  // Only two embed players are used, because only those were verified to work
  // from inside the app. YouTube refuses to embed here at all — its player
  // returns "Error 153" when the request has no web origin, which a desktop
  // app cannot give it — so YouTube previews load the normal watch page, which
  // does work. Music links are rewritten to the main site so the preview never
  // lands on the Music web app's sign-in wall.
  function previewEmbedUrl(url) {
    const u = String(url || '');
    let m;
    if ((m = /[?&]v=([\w-]{11})/.exec(u))) return `https://www.youtube.com/watch?v=${m[1]}`;
    if ((m = /youtu\.be\/([\w-]{11})/.exec(u))) return `https://www.youtube.com/watch?v=${m[1]}`;
    if ((m = /vimeo\.com\/(\d+)/.exec(u))) return `https://player.vimeo.com/video/${m[1]}?autoplay=1`;
    if ((m = /dailymotion\.com\/video\/([a-z0-9]+)/i.exec(u))) return `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1`;
    return u; // everything else: the video's own page
  }

  function openPreview(r) {
    if (!previewModal || !r || !r.url) return;
    previewItem = r;
    previewTitle.textContent = r.title || 'Preview';
    previewSite.textContent = r.site || '';

    closePreviewPlayer();
    const view = document.createElement('webview');
    view.setAttribute('src', previewEmbedUrl(r.url));
    // Same session as the Browser tab on purpose: sites that want a sign-in
    // (age-restricted videos, members-only, private posts) can be logged into
    // once over there, and the preview is then signed in too.
    view.setAttribute('partition', 'persist:browser');
    view.className = 'preview-view';
    previewStage.appendChild(view);

    previewModal.classList.remove('hidden');
  }

  // Removing the webview is what stops playback; hiding the modal alone would
  // leave the audio running behind it.
  function closePreviewPlayer() {
    if (previewStage) previewStage.innerHTML = '';
  }

  function closePreview() {
    if (!previewModal) return;
    previewModal.classList.add('hidden');
    closePreviewPlayer();
    previewItem = null;
  }

  if (previewClose) previewClose.addEventListener('click', closePreview);
  if (previewModal) {
    previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewModal && !previewModal.classList.contains('hidden')) closePreview();
  });
  if (previewVideoBtn) {
    previewVideoBtn.addEventListener('click', () => {
      const item = previewItem;
      closePreview();
      if (item) sendToDownloader(item.url, 'video');
    });
  }
  if (previewAudioBtn) {
    previewAudioBtn.addEventListener('click', () => {
      const item = previewItem;
      closePreview();
      if (item) sendToDownloader(item.url, 'audio');
    });
  }
  if (previewOpenBtn) {
    previewOpenBtn.addEventListener('click', () => {
      const item = previewItem;
      closePreview();
      if (item && typeof bvNavigate === 'function') bvNavigate(item.url);
    });
  }

  // ---- Bulk selection and download ---------------------------------------
  //
  // The queue itself now lives in app.js, where every download goes through it
  // and each waiting job has a visible card. This used to keep its own second
  // queue, which is why bulk picks were invisible on the Downloads tab: they
  // were held here and only became cards once they started.

  const bulkBar = document.getElementById('searchBulkBar');
  const bulkSelectAll = document.getElementById('bulkSelectAll');
  const bulkCount = document.getElementById('bulkCount');
  const bulkVideoBtn = document.getElementById('bulkVideoBtn');
  const bulkAudioBtn = document.getElementById('bulkAudioBtn');
  const bulkClearBtn = document.getElementById('bulkClearBtn');


  function resultRows() {
    return [...searchResults.querySelectorAll('.search-item')]
      .filter((el) => el.veloxItem && !el.veloxItem.isPlaylist);
  }

  function pickedRows() {
    return resultRows().filter((el) => {
      const box = el.querySelector('.pick-box');
      return box && box.checked;
    });
  }

  function refreshBulkBar() {
    if (!bulkBar) return;
    const rows = resultRows();
    const picked = pickedRows();

    bulkBar.classList.toggle('hidden', rows.length === 0);
    if (bulkSelectAll) {
      bulkSelectAll.checked = rows.length > 0 && picked.length === rows.length;
      bulkSelectAll.indeterminate = picked.length > 0 && picked.length < rows.length;
    }

    if (bulkCount) {
      bulkCount.textContent = picked.length
        ? `${picked.length} of ${rows.length} selected`
        : 'Nothing selected';
    }
    [bulkVideoBtn, bulkAudioBtn, bulkClearBtn].forEach((b) => {
      if (b) b.disabled = picked.length === 0;
    });
  }

  function setAllPicked(on) {
    resultRows().forEach((el) => {
      const box = el.querySelector('.pick-box');
      if (!box) return;
      box.checked = on;
      el.classList.toggle('picked', on);
    });
    refreshBulkBar();
  }

  function startBulkDownload(mode) {
    const picked = pickedRows();
    if (!picked.length) return;
    if (!state.folder) {
      alert('Pick a save folder first.');
      return;
    }

    // queueDownload reads state.mode when it builds each job, so set it once
    // for the whole batch rather than per call.
    const previous = state.mode;
    state.mode = mode;
    try {
      picked.forEach((el) => {
        try { queueDownload(el.veloxItem.url, {}); } catch (err) { /* keep going */ }
        const box = el.querySelector('.pick-box');
        if (box) box.checked = false;
        el.classList.remove('picked');
        el.classList.add('queued');
      });
    } finally {
      state.mode = previous;
    }

    openTab('new');
    switchMode(mode);
    refreshBulkBar();
  }

  if (bulkSelectAll) bulkSelectAll.addEventListener('change', (e) => setAllPicked(e.target.checked));
  if (bulkClearBtn) bulkClearBtn.addEventListener('click', () => setAllPicked(false));
  if (bulkVideoBtn) bulkVideoBtn.addEventListener('click', () => startBulkDownload('video'));
  if (bulkAudioBtn) bulkAudioBtn.addEventListener('click', () => startBulkDownload('audio'));

  // ---- Infinite scroll ----------------------------------------------------
  //
  // Page 1 comes from the search itself. After that a sentinel sits under the
  // last result; when it scrolls into view the next page is fetched and
  // appended. The feed stops when the site runs out, when a page adds nothing
  // new, or as soon as a fresh search starts.

  function startFeed(f) {
    stopFeed();
    feed = { ...f, page: 1, loading: false, ended: !f.hasMore };
    if (feed.ended) return;

    sentinel = document.createElement('div');
    sentinel.className = 'search-sentinel';
    searchResults.appendChild(sentinel);

    // Observe against the element that actually scrolls, so the sentinel is
    // seen whether the pane scrolls or the window does.
    feedObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadNextPage();
    }, { root: scrollParentOf(searchResults), rootMargin: '600px 0px' });
    feedObserver.observe(sentinel);
  }

  function stopFeed() {
    if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
    if (sentinel) { sentinel.remove(); sentinel = null; }
    feed = null;
  }

  function scrollParentOf(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === 'auto' || oy === 'scroll') return node;
      node = node.parentElement;
    }
    return null; // the viewport
  }

  function feedNote(text) {
    let note = searchResults.querySelector('.search-feed-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'search-feed-note';
      searchResults.appendChild(note);
    }
    note.textContent = text;
    if (sentinel) searchResults.appendChild(sentinel); // keep it last
    return note;
  }

  function clearFeedNote() {
    const note = searchResults.querySelector('.search-feed-note');
    if (note) note.remove();
  }

  async function loadNextPage() {
    if (!feed || feed.loading || feed.ended) return;
    if (feed.token !== searchToken) { stopFeed(); return; }

    feed.loading = true;
    const next = feed.page + 1;
    feedNote(`Loading more from ${feed.siteName}…`);

    let res;
    try {
      res = await window.api.siteSearch(feed.siteId, feed.query, PAGE_SIZE, next, feed.kind || searchKind);
    } catch (err) {
      res = { ok: false, error: (err && err.message) || 'request failed' };
    }

    // A new search started while this page was in flight.
    if (!feed || feed.token !== searchToken) return;
    feed.loading = false;
    clearFeedNote();

    if (!res || !res.ok) {
      feed.ended = true;
      feedNote(`Could not load more: ${(res && res.error) || 'request failed'}`);
      if (feedObserver) feedObserver.disconnect();
      return;
    }

    const added = (res.items || []).reduce((n, r) => n + (renderMediaResult(r) ? 1 : 0), 0);
    feed.page = next;
    if (sentinel) searchResults.appendChild(sentinel);

    setStatus(`${renderedUrls.size} results from ${feed.siteName}.`);

    // No new items means the source is repeating itself or has run dry.
    if (!added || !res.hasMore) {
      feed.ended = true;
      if (feedObserver) feedObserver.disconnect();
      if (sentinel) { sentinel.remove(); sentinel = null; }
      feedNote(`That's everything ${feed.siteName} returned for "${feed.query}".`);
    }
  }

  // Sites with no machine-readable search still work: open their own search
  // page in the built-in browser tab and download from there.
  function renderHandoff(site, res, query) {
    const div = document.createElement('div');
    div.className = 'search-handoff';
    const isLink = res.mode === 'link';
    div.innerHTML = `
      <h4>${escapeHtmlPF(site.name)} has no search Velox can read directly</h4>
      <p>${isLink
        ? `Velox can download from ${escapeHtmlPF(site.name)}, but the site exposes no search page. Find the video yourself, then paste its link into the URL box.`
        : `Velox will open the ${escapeHtmlPF(site.name)} search for "${escapeHtmlPF(query)}" in the browser tab. Open a video there and press DOWNLOAD THIS PAGE.`}</p>
      <div class="row">
        <button class="primary-btn sm go-browse">${isLink ? 'OPEN SITE' : 'OPEN SEARCH IN BROWSER'}</button>
        <button class="ghost-btn sm go-external">Open in system browser</button>
      </div>
    `;
    const target = res.browseUrl;
    div.querySelector('.go-browse').addEventListener('click', () => {
      if (typeof bvNavigate === 'function') bvNavigate(target);
    });
    div.querySelector('.go-external').addEventListener('click', () => window.api.openExternal(target));
    searchResults.appendChild(div);
  }

  // ---- The four kinds of search ------------------------------------------

  // A pasted link: probe it and offer the download straight away.
  async function searchByUrl(url, token) {
    setStatus(`Reading ${url}…`, false, true);
    const res = await window.api.fetchInfo(url);
    if (token !== searchToken) return;
    if (!res || !res.ok) {
      setStatus(res && res.error ? res.error : 'Could not read that link.', true);
      return;
    }
    setStatus('Found 1 item.');
    renderMediaResult({
      title: res.title || url,
      url,
      thumbnail: res.thumbnail,
      duration: res.duration,
      uploader: res.uploader,
      site: '',
    });
  }

  // A site was picked: search inside it.
  async function searchOneSite(query, token) {
    setStatus(`Searching ${selectedSite.name} for "${query}"…`, false, true);
    const res = await window.api.siteSearch(selectedSite.id, query, PAGE_SIZE, 1, searchKind);
    if (token !== searchToken) return;

    if (!res || !res.ok) {
      setStatus((res && res.error) || `${selectedSite.name} search failed.`, true);
      if (res && res.browseUrl) renderHandoff(selectedSite, res, query);
      return;
    }

    if (res.mode === 'browser' || res.mode === 'link') {
      setStatus('');
      renderHandoff(selectedSite, res, query);
      return;
    }

    if (!res.items.length) {
      setStatus(`No results on ${selectedSite.name} for "${query}".`);
      renderHandoff(selectedSite, res, query);
      return;
    }

    const added = res.items.reduce((n, r) => n + (renderMediaResult(r) ? 1 : 0), 0);
    setStatus(`${added} results from ${selectedSite.name}.`);

    // Hand the rest of the list to the infinite scroller.
    startFeed({
      siteId: selectedSite.id,
      siteName: selectedSite.name,
      query,
      token,
      kind: searchKind,
      hasMore: !!res.hasMore,
    });
  }

  // Torrent trackers, unchanged from the previous Search tab.
  async function searchTorrents(query, token) {
    simulateServerLoad(searchStatus, `Searching global torrents for "${query}"…`);
    const [res] = await Promise.all([
      window.api.searchGlobal(query),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    if (token !== searchToken) return;

    if (!res || !res.length || (res.length === 1 && res[0].title === 'No results returned')) {
      setStatus('No torrents found for this query.');
      return;
    }
    setStatus(`Found ${res.length} torrent results from the global network.`);

    res.forEach((t) => {
      const div = document.createElement('div');
      div.className = 'search-item torrent-item';
      div.style.cssText = 'background: var(--velox-bg-card); border-radius: var(--velox-r-md); padding: 15px; display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--velox-border);';
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap: 10px;">
          <h4 style="margin:0; font-size:14px; color:var(--velox-text); word-break: break-all;">${escapeHtmlPF(t.title)}</h4>
          <span style="font-size:12px; background:rgba(74, 144, 226, 0.2); color:var(--velox-accent); padding: 2px 6px; border-radius:4px; white-space:nowrap;">${escapeHtmlPF(t.size)}</span>
        </div>
        <div style="display:flex; gap: 15px; font-size:12px; color:var(--velox-text-dim);">
          <span style="color:#2ecc71;">▲ ${escapeHtmlPF(t.seeds)} Seeds</span>
          <span style="color:#e74c3c;">▼ ${escapeHtmlPF(t.peers)} Peers</span>
          <span>Provider: ${escapeHtmlPF(t.provider)}</span>
        </div>
        <div style="display:flex; gap:10px; margin-top:5px;">
          <button class="primary-btn sm download-torrent-btn" style="flex:1;">DOWNLOAD TORRENT</button>
        </div>
      `;
      div.querySelector('.download-torrent-btn').addEventListener('click', async (btnE) => {
        const btn = btnE.target;
        let magnet = t.magnet;
        if (!magnet && t.url) {
          btn.textContent = 'FETCHING...';
          btn.disabled = true;
          btn.style.opacity = '0.7';
          try { magnet = await window.api.fitgirlGetMagnet(t.url); } catch (err) {}
        }
        if (magnet && window.addTorrentFromAnywhere) {
          btn.textContent = 'STARTING...';
          window.addTorrentFromAnywhere(magnet, t.title);
          btn.textContent = 'ADDED ✓';
          btn.style.background = '#27ae60';
        } else {
          btn.textContent = 'NO MAGNET';
          btn.style.background = '#e74c3c';
        }
        setTimeout(() => {
          btn.textContent = 'DOWNLOAD TORRENT';
          btn.style.background = '';
          btn.disabled = false;
          btn.style.opacity = '1';
        }, 3000);
      });
      searchResults.appendChild(div);
    });
  }


  // Softwares Logic
  const softwaresSearchInput = document.getElementById('softwaresSearchInput');
  const refreshSoftwaresBtn = document.getElementById('refreshSoftwaresBtn');
  const softwaresResults = document.getElementById('softwaresResults');
  let softwaresSearchTimeout;

  async function loadSoftwares(query = null) {
    const statusContainer = document.getElementById('softwaresStatus');
    const statusText = document.getElementById('softwaresStatusText');
    
    statusContainer.style.display = 'flex';
    if(statusContainer.querySelector('.loader-bar')) statusContainer.querySelector('.loader-bar').style.display = 'block';
    
    const finalMsg = query ? `Searching softwares for "${query}"...` : 'Fetching latest pro applications...';
    simulateServerLoad(statusText, finalMsg);
    
    const fetchPromise = query ? window.api.softwareSearch(query) : window.api.softwareFetch();
    const delayPromise = new Promise(r => setTimeout(r, 1500));
    
    try {
      const [softwares] = await Promise.all([fetchPromise, delayPromise]);
      
      if (softwares.length === 0) {
        statusContainer.style.display = 'flex';
        if(statusContainer.querySelector('.loader-bar')) statusContainer.querySelector('.loader-bar').style.display = 'none';
        statusText.textContent = query ? 'No software found matching your query.' : 'No software available right now.';
        softwaresResults.innerHTML = '';
        return;
      }

      statusContainer.style.display = 'none';
      softwaresResults.innerHTML = '';
      
      softwares.forEach(s => {
        if (!s) return;
        const div = document.createElement('div');
        div.className = 'search-item';
        div.style.background = 'var(--velox-bg-card)';
        div.style.borderRadius = 'var(--velox-r-md)';
        div.style.padding = '12px';
        div.style.display = 'flex';
        div.style.gap = '15px';
        div.style.alignItems = 'center';
        div.style.border = '1px solid var(--velox-border)';
        
        // Software icon
        const iconSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234a90e2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolygon points='12 2 2 7 12 12 22 7 12 2'%3E%3C/polygon%3E%3Cpolyline points='2 17 12 22 22 17'%3E%3C/polyline%3E%3Cpolyline points='2 12 12 17 22 12'%3E%3C/polyline%3E%3C/svg%3E`;

        div.innerHTML = `
          <div style="width: 50px; height: 50px; background: #0b0f19; border-radius: var(--velox-r-sm); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
            <img src="${iconSvg}" alt="software icon" style="width: 28px; height: 28px;" />
          </div>
          <div style="flex: 1; min-width: 0;">
            <h4 style="margin: 0 0 6px 0; color: var(--velox-text); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.title}</h4>
            <div style="display: flex; gap: 15px; color: var(--velox-text-dim); font-size: 11px;">
              <span><strong style="color: var(--velox-accent);">Size:</strong> ${s.size}</span>
              <span><strong style="color: var(--velox-green);">Seeds:</strong> ${s.seeds}</span>
              <span><strong style="color: var(--velox-text);">Date:</strong> ${s.time}</span>
            </div>
          </div>
          <button class="primary-btn sm download-btn" style="white-space: nowrap; font-weight: bold;">DOWNLOAD</button>
        `;
        
        div.querySelector('.download-btn').addEventListener('click', async (e) => {
          const btn = e.target;
          let magnet = s.magnet;
          
          if (!magnet && s.url) {
            btn.textContent = 'FETCHING...';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            try {
              magnet = await window.api.fitgirlGetMagnet(s.url);
            } catch (err) {}
            btn.disabled = false;
            btn.style.opacity = '1';
          }
          
          if (magnet) {
            btn.textContent = 'STARTING...';
            if (window.addTorrentFromAnywhere) {
              window.addTorrentFromAnywhere(magnet, s.title);
            }
            btn.textContent = 'ADDED ✓';
            btn.style.background = '#27ae60';
            setTimeout(() => {
              btn.textContent = 'DOWNLOAD';
              btn.style.background = '';
            }, 3000);
          } else {
            btn.textContent = 'NOT FOUND';
            btn.style.background = '#e74c3c';
            setTimeout(() => {
              btn.textContent = 'DOWNLOAD';
              btn.style.background = '';
            }, 3000);
          }
        });

        softwaresResults.appendChild(div);
      });
    } catch (err) {
      console.error(err);
      statusContainer.style.display = 'flex';
      if(statusContainer.querySelector('.loader-bar')) statusContainer.querySelector('.loader-bar').style.display = 'none';
      statusText.textContent = 'Failed to load software database.';
    }
  }

  if (refreshSoftwaresBtn) {
    refreshSoftwaresBtn.addEventListener('click', () => loadSoftwares());
    // Auto load on tab click
    document.querySelector('[data-tab="softwares"]').addEventListener('click', () => {
      if (softwaresResults.children.length === 0) {
        loadSoftwares();
      }
    });
  }

  if (softwaresSearchInput) {
    softwaresSearchInput.addEventListener('input', (e) => {
      clearTimeout(softwaresSearchTimeout);
      const query = e.target.value.trim();
      if (query.length > 2) {
        softwaresSearchTimeout = setTimeout(() => {
          loadSoftwares(query);
        }, 800);
      } else if (query.length === 0) {
        loadSoftwares();
      }
    });
  }

    // Torrents Logic (Advanced Table Mode)
  
  const torrentTableBody = document.getElementById('torrentTableBody');
  const addMagnetBtn = document.getElementById('addMagnetBtn');
  const addTorrentFileBtn = document.getElementById('addTorrentFileBtn');
  const changeSavePathBtn = document.getElementById('changeSavePathBtn');
  const openSavePathBtn = document.getElementById('openSavePathBtn');
  const savePathDisplay = document.getElementById('savePathDisplay');
  
  let currentSavePath = '';
  
  window.api.defaultDownloadFolder().then(p => {
    currentSavePath = p;
    if(savePathDisplay) savePathDisplay.textContent = p;
  });

  if (changeSavePathBtn) {
    changeSavePathBtn.addEventListener('click', async () => {
      const path = await window.api.selectSavePath();
      if (path) {
        currentSavePath = path;
        savePathDisplay.textContent = path;
      }
    });
  }

  if (openSavePathBtn) {
    openSavePathBtn.addEventListener('click', () => {
      window.api.openExternalFolder(currentSavePath);
    });
  }

  // Rows are saved in localStorage with what a restart needs to carry on where
  // it stopped: the folder the torrent downloads into, its info hash (the main
  // process keeps its metadata and bitfield under that) and which files were
  // chosen. `confirmed` stays false until files are picked, which is also when
  // the licence credit is spent.
  function saveTorrents(list) {
    localStorage.setItem('velox_torrents', JSON.stringify(list));
  }
  function getTorrents() {
    try { return JSON.parse(localStorage.getItem('velox_torrents')) || []; } catch(e) { return []; }
  }
  function updateSavedTorrent(id, patch) {
    const saved = getTorrents();
    const item = saved.find((x) => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    saveTorrents(saved);
  }
  function torrentRow(id) {
    return torrentTableBody && torrentTableBody.querySelector(`.torrent-row[data-id="${CSS.escape(id)}"]`);
  }
  function dropTorrent(id) {
    const row = torrentRow(id);
    if (row) row.remove();
    saveTorrents(getTorrents().filter((x) => x.id !== id));
    forgetPicker(id);
  }

  // The default folder arrives asynchronously. Restores used to read it before
  // it had, got an empty path, and WebTorrent then started them from zero in
  // its temp folder instead of resuming the files already downloaded.
  async function torrentSavePath() {
    if (!currentSavePath) currentSavePath = await window.api.defaultDownloadFolder();
    return currentSavePath;
  }

  const TORRENT_STATE_LABELS = {
    metadata: 'Fetching info',
    select: 'Choose files',
    checking: 'Checking files',
    paused: 'Paused',
    downloading: 'Downloading',
    seeding: 'Seeding',
  };

  function fmtTorrentBytes(n) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    n = Number(n) || 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? (n >= 100 ? 0 : 1) : 0)} ${units[i]}`;
  }

  function fmtTorrentEta(ms) {
    const s = Math.round(ms / 1000);
    if (s > 86400) return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
    if (s > 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function showTorrentNotice(message) {
    const box = document.getElementById('torrentNotice');
    if (!box) return;
    if (!message) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = message;
    box.hidden = false;
  }

  function setTorrentPaused(tr, paused) {
    tr.querySelector('.pause-btn').style.display = paused ? 'none' : 'flex';
    tr.querySelector('.resume-btn').style.display = paused ? 'flex' : 'none';
  }

  // (Re)starts a saved row in the main process.
  function addSavedTorrent(t, paused) {
    return window.api.torrentAdd({
      id: t.id,
      torrentId: t.id,
      hash: t.hash,
      savePath: t.savePath,
      selected: t.selected || null,
      confirmed: !!t.confirmed,
      paused: !!paused,
    });
  }

  // Every add goes through here so a refusal is handled the same way whichever
  // button started it: the row comes back out and the reason is shown. Adding
  // only fetches the file list; the picker opens when it arrives, and the
  // credit is spent when the user starts the download there, so backing out
  // of the picker costs nothing.
  async function startTorrent(tObj) {
    showTorrentNotice('');
    if (getTorrents().some((x) => x.id === tObj.id)) {
      showTorrentNotice('That torrent is already in the list.');
      return false;
    }
    tObj.savePath = await torrentSavePath();
    tObj.confirmed = false;
    tObj.status = TORRENT_STATE_LABELS.metadata;
    saveTorrents([...getTorrents(), tObj]);
    renderTorrentRow(tObj);

    const res = await addSavedTorrent(tObj, false);
    if (res && res.ok === false) {
      dropTorrent(tObj.id);
      showTorrentNotice(res.error || 'This torrent could not be started.');
      return false;
    }
    return true;
  }

  window.addTorrentFromAnywhere = async function(magnet, title) {
    document.querySelector('[data-tab="torrents"]').click();
    if (!magnet) return;
    await startTorrent({ id: magnet, name: title || 'Starting...', progress: 0, done: false });
  };

  function renderTorrentRow(t) {
    if (!torrentTableBody || torrentRow(t.id)) return;

    const pct = Number(t.progress) || 0;
    const tr = document.createElement('tr');
    tr.className = 'torrent-row';
    tr.dataset.id = t.id;
    tr.innerHTML = `
      <td><div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:230px;" class="t-name"></div></td>
      <td class="t-size"></td>
      <td>
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="flex:1; height:4px; background:var(--velox-border); border-radius:2px; overflow:hidden;">
            <div class="t-progress-bar" style="width: ${pct}%; height:100%; background:var(--velox-accent);"></div>
          </div>
          <span class="t-percent" style="font-size:11px;">${pct}%</span>
        </div>
      </td>
      <td class="t-status"></td>
      <td class="t-dspeed">--</td>
      <td class="t-uspeed">--</td>
      <td class="t-eta">--</td>
      <td class="t-peers">0</td>
      <td class="tbl-actions">
        <button class="tbl-icon-btn files-btn" title="Choose files"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><line x1="9" y1="6" x2="20" y2="6"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="18" x2="20" y2="18"></line><line x1="4" y1="6" x2="4.01" y2="6"></line><line x1="4" y1="12" x2="4.01" y2="12"></line><line x1="4" y1="18" x2="4.01" y2="18"></line></svg></button>
        <button class="tbl-icon-btn pause-btn" title="Pause"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg></button>
        <button class="tbl-icon-btn resume-btn" title="Resume" style="display:none;"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></button>
        <button class="tbl-icon-btn remove-btn" title="Remove"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
      </td>
    `;
    // Torrent names come from strangers, so they go in as text, not markup.
    tr.querySelector('.t-name').textContent = t.name || 'Starting...';
    tr.querySelector('.t-size').textContent = t.sizeFormatted || '--';
    tr.querySelector('.t-status').textContent = t.done ? 'Completed' : (t.status || 'Initializing');
    torrentTableBody.appendChild(tr);

    tr.querySelector('.files-btn').onclick = () => openTorrentFiles(t.id);

    tr.querySelector('.pause-btn').onclick = async () => {
      await window.api.torrentPause(t.id);
      setTorrentPaused(tr, true);
      tr.querySelector('.t-status').textContent = TORRENT_STATE_LABELS.paused;
      updateSavedTorrent(t.id, { status: TORRENT_STATE_LABELS.paused });
    };

    tr.querySelector('.resume-btn').onclick = async () => {
      // Resume re-checks the licence but spends no credit. If the licence has
      // gone invalid since the torrent started, leave the row paused rather
      // than showing "Downloading" over a torrent that is not running.
      let res = await window.api.torrentResume(t.id);
      if (res && res.notLoaded) {
        // Not running this session (its restore was refused, or it failed):
        // start it again the way a restart would.
        const saved = getTorrents().find((x) => x.id === t.id);
        if (!saved) return;
        res = await addSavedTorrent(saved, false);
      }
      if (res && res.ok === false) {
        showTorrentNotice(res.error || 'This torrent could not be resumed.');
        return;
      }
      showTorrentNotice('');
      setTorrentPaused(tr, false);
      tr.querySelector('.t-status').textContent = TORRENT_STATE_LABELS.downloading;
      updateSavedTorrent(t.id, { status: TORRENT_STATE_LABELS.downloading });
    };

    tr.querySelector('.remove-btn').onclick = () => {
      window.api.torrentRemove({ id: t.id, destroyStore: false });
      dropTorrent(t.id);
    };

    if (t.done) {
      // Finished in an earlier session and not re-added, so there is nothing
      // running to pause or re-pick.
      tr.querySelectorAll('.files-btn, .pause-btn, .resume-btn').forEach((b) => { b.style.display = 'none'; });
    } else {
      setTorrentPaused(tr, t.status === TORRENT_STATE_LABELS.paused);
    }
  }

  // Re-add everything not finished. A confirmed torrent comes back in its own
  // folder with its file choice, so it carries on from where it stopped; one
  // closed before its files were picked brings the picker back.
  async function restoreTorrents() {
    const fallback = await torrentSavePath();
    const saved = getTorrents();
    let changed = false;
    for (const t of saved) {
      // Rows saved before the picker existed have no `confirmed`: they were
      // started with every file, and their credit spent, when added.
      if (t.confirmed === undefined) { t.confirmed = true; t.selected = null; changed = true; }
      if (!t.savePath) { t.savePath = fallback; changed = true; }
    }
    if (changed) saveTorrents(saved);

    for (const t of saved) {
      renderTorrentRow(t);
      if (t.done) continue;
      addSavedTorrent(t, t.status === TORRENT_STATE_LABELS.paused).then((res) => {
        if (!res || res.ok !== false) return;
        const tr = torrentRow(t.id);
        if (tr) {
          tr.querySelector('.t-status').textContent = 'Stopped';
          setTorrentPaused(tr, true);
        }
        showTorrentNotice(res.error || 'A saved torrent could not be restarted.');
      });
    }
  }

  if (addMagnetBtn) {
    addMagnetBtn.addEventListener('click', async () => {
      // Create a quick custom modal for Magnet link
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.8); z-index:9999; display:flex; align-items:center; justify-content:center;';
      modal.innerHTML = `
        <div style="background:var(--velox-bg); padding:20px; border-radius:8px; width:400px; border:1px solid var(--velox-border);">
          <h3 style="margin-top:0;">Add Magnet Link</h3>
          <input type="text" id="magInput" style="width:100%; padding:8px; margin-bottom:15px; box-sizing:border-box;" placeholder="magnet:?xt=urn:btih:..." />
          <div style="display:flex; justify-content:flex-end; gap:10px;">
            <button class="ghost-btn" id="magCancel">Cancel</button>
            <button class="primary-btn" id="magAdd">Add</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      document.getElementById('magInput').focus();

      document.getElementById('magCancel').onclick = () => modal.remove();
      document.getElementById('magAdd').onclick = async () => {
        const val = document.getElementById('magInput').value.trim();
        modal.remove();
        if (val) await startTorrent({ id: val, name: 'Starting Torrent...', progress: 0, done: false });
      };
    });
  }

  if (addTorrentFileBtn) {
    addTorrentFileBtn.addEventListener('click', async () => {
      const filePath = await window.api.openTorrentFile();
      if (filePath) {
        await startTorrent({ id: filePath, name: 'Starting Torrent File...', progress: 0, done: false });
      }
    });
  }

  // ---- File picker ----------------------------------------------------------
  //
  // Opens as soon as a torrent's file list is known, before anything has
  // downloaded, so only the files ticked here are fetched. A row's Files button
  // reopens it to change the choice later. One picker at a time: a restart can
  // bring several unpicked torrents back at once, and they wait their turn.

  const pickerQueue = [];
  let picker = null; // { id, close }

  function queuePicker(req) {
    if ((picker && picker.id === req.id) || pickerQueue.some((r) => r.id === req.id)) return;
    pickerQueue.push(req);
    nextPicker();
  }

  function nextPicker() {
    while (!picker && pickerQueue.length) {
      const req = pickerQueue.shift();
      if (torrentRow(req.id)) showPicker(req);
    }
  }

  // The torrent went away (removed, failed): drop its picker without acting.
  function forgetPicker(id) {
    const i = pickerQueue.findIndex((r) => r.id === id);
    if (i !== -1) pickerQueue.splice(i, 1);
    if (picker && picker.id === id) picker.close();
  }

  async function openTorrentFiles(id) {
    const data = await window.api.torrentGetFiles(id);
    if (!data) {
      showTorrentNotice('The file list is not available yet. It appears once the torrent info has been fetched.');
      return;
    }
    queuePicker({ id, ...data });
  }

  function showPicker({ id, name, files, confirmed }) {
    const editing = !!confirmed;
    const checked = new Set(files.filter((f) => f.selected).map((f) => f.index));
    // Multi-file torrents put everything under a folder named after the
    // torrent; repeating it on every line only pushes the file names away.
    const prefix = files.length > 1 && name && files.every((f) => f.path.startsWith(name + '/')) ? name.length + 1 : 0;
    const total = files.reduce((n, f) => n + f.length, 0);

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal modal-wide tfiles-modal" role="dialog" aria-modal="true" aria-labelledby="tfilesTitle">
        <button class="modal-close" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
        <div class="modal-header"><h3 class="modal-title" id="tfilesTitle"></h3></div>
        <div class="tfiles-name"></div>
        <div class="tfiles-tools">
          <button type="button" class="ghost-btn sm" data-act="all">Select all</button>
          <button type="button" class="ghost-btn sm" data-act="none">Select none</button>
          <input type="search" class="tfiles-filter" placeholder="Filter files" />
          <span class="tfiles-summary"></span>
        </div>
        <div class="tfiles-list"></div>
        <div class="torrent-notice tfiles-error" hidden></div>
        <div class="tfiles-foot">
          <button type="button" class="ghost-btn" data-act="cancel">Cancel</button>
          <button type="button" class="primary-btn" data-act="ok"></button>
        </div>
      </div>
    `;
    const $ = (sel) => backdrop.querySelector(sel);
    $('.modal-title').textContent = editing ? 'Change which files download' : 'Choose files to download';
    $('.tfiles-name').textContent = name || '';
    const okBtn = $('[data-act="ok"]');
    okBtn.textContent = editing ? 'Save' : 'Start download';
    const filter = $('.tfiles-filter');
    if (files.length < 8) filter.hidden = true;

    const list = $('.tfiles-list');
    const rows = files.map((f) => {
      const rel = f.path.slice(prefix);
      const cut = rel.lastIndexOf('/') + 1;
      const row = document.createElement('label');
      row.className = 'tfiles-row';
      row.innerHTML = '<input type="checkbox"><span class="tfiles-path"><span class="tfiles-dir"></span><span class="tfiles-file"></span></span><span class="tfiles-pct"></span><span class="tfiles-size"></span>';
      row.querySelector('.tfiles-dir').textContent = rel.slice(0, cut);
      row.querySelector('.tfiles-file').textContent = rel.slice(cut);
      row.querySelector('.tfiles-path').title = rel;
      row.querySelector('.tfiles-size').textContent = fmtTorrentBytes(f.length);
      if (f.progress >= 1) row.querySelector('.tfiles-pct').textContent = 'Done';
      else if (f.progress > 0) row.querySelector('.tfiles-pct').textContent = Math.floor(f.progress * 100) + '%';
      const box = row.querySelector('input');
      box.checked = checked.has(f.index);
      box.addEventListener('change', () => {
        if (box.checked) checked.add(f.index); else checked.delete(f.index);
        refresh();
      });
      list.appendChild(row);
      return { f, row, box, text: rel.toLowerCase() };
    });

    function refresh() {
      let bytes = 0;
      for (const r of rows) if (checked.has(r.f.index)) bytes += r.f.length;
      $('.tfiles-summary').textContent = `${checked.size} of ${files.length} files · ${fmtTorrentBytes(bytes)} of ${fmtTorrentBytes(total)}`;
      okBtn.disabled = checked.size === 0;
    }

    // Select all / none act on what the filter shows, so filtering for
    // "optional" and pressing none drops every optional pack in one go.
    function setShown(on) {
      for (const r of rows) {
        if (r.row.hidden) continue;
        r.box.checked = on;
        if (on) checked.add(r.f.index); else checked.delete(r.f.index);
      }
      refresh();
    }
    $('[data-act="all"]').onclick = () => setShown(true);
    $('[data-act="none"]').onclick = () => setShown(false);
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) r.row.hidden = !!q && !r.text.includes(q);
    });

    function onKey(e) {
      if (e.key === 'Escape') cancel();
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      picker = null;
      nextPicker();
    }
    // Backing out of a new torrent removes it: nothing has downloaded and no
    // credit has been spent on it yet.
    function cancel() {
      close();
      if (!editing) {
        window.api.torrentRemove({ id, destroyStore: false });
        dropTorrent(id);
      }
    }
    $('.modal-close').onclick = cancel;
    $('[data-act="cancel"]').onclick = cancel;

    okBtn.onclick = async () => {
      okBtn.disabled = true;
      const selected = checked.size === files.length ? null : [...checked].sort((a, b) => a - b);
      const res = await window.api.torrentStart({ id, selected });
      if (res && res.ok === false) {
        const err = $('.tfiles-error');
        err.textContent = res.error || 'The download could not be started.';
        err.hidden = false;
        okBtn.disabled = false;
        return;
      }
      updateSavedTorrent(id, { confirmed: true, selected });
      close();
    };

    picker = { id, close };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    refresh();
  }

  // Restore on boot
  if (torrentTableBody) restoreTorrents();

  window.api.onTorrentFiles((data) => {
    if (data && torrentRow(data.id)) queuePicker(data);
  });

  window.api.onTorrentError((data) => {
    showTorrentNotice((data && data.error) || 'Torrent failed.');
    const saved = data && getTorrents().find((x) => x.id === data.id);
    if (!saved) return;
    // Before its files were chosen a torrent has downloaded nothing and cost
    // nothing, so it just goes. A started one stays, and Resume retries it.
    if (!saved.confirmed) { dropTorrent(data.id); return; }
    const tr = torrentRow(data.id);
    if (tr) {
      tr.querySelector('.t-status').textContent = 'Error';
      setTorrentPaused(tr, true);
    }
  });

  window.api.onTorrentProgress((prog) => {
    const tr = torrentRow(prog.id);
    if (!tr) return;

    const name = prog.name || 'Fetching info...';
    const status = TORRENT_STATE_LABELS[prog.state] || TORRENT_STATE_LABELS.downloading;
    tr.querySelector('.t-name').textContent = name;
    tr.querySelector('.t-status').textContent = status;
    setTorrentPaused(tr, prog.state === 'paused');
    tr.querySelector('.t-dspeed').textContent = (prog.downloadSpeed / 1024 / 1024).toFixed(2) + ' MB/s';
    tr.querySelector('.t-uspeed').textContent = (prog.uploadSpeed / 1024 / 1024).toFixed(2) + ' MB/s';
    tr.querySelector('.t-peers').textContent = prog.numPeers;
    tr.querySelector('.t-eta').textContent =
      prog.state === 'downloading' && prog.timeRemaining ? fmtTorrentEta(prog.timeRemaining) : '--';

    const patch = { name, status };
    // The hash is missing for a moment while a magnet is parsed; keep the
    // saved one rather than wiping it.
    if (prog.infoHash) patch.hash = prog.infoHash;
    if (prog.length > 0) {
      const percent = (prog.progress * 100).toFixed(2);
      tr.querySelector('.t-progress-bar').style.width = `${percent}%`;
      tr.querySelector('.t-percent').textContent = `${percent}%`;
      tr.querySelector('.t-size').textContent = `${fmtTorrentBytes(prog.downloaded)} / ${fmtTorrentBytes(prog.length)}`;
      patch.progress = percent;
      patch.sizeFormatted = fmtTorrentBytes(prog.length);
    }
    // More files were ticked on a finished torrent: it is downloading again.
    if (prog.state === 'downloading') patch.done = false;
    updateSavedTorrent(prog.id, patch);
  });

  window.api.onTorrentDone((data) => {
    playNotification();
    showNativeNotification('Download Complete', `${data.name} has finished downloading.`);

    const tr = torrentRow(data.id);
    if (tr) {
      tr.querySelector('.t-status').textContent = 'Completed';
      tr.querySelector('.t-progress-bar').style.width = '100%';
      tr.querySelector('.t-percent').textContent = '100%';
      tr.querySelector('.t-eta').textContent = '-';
    }
    updateSavedTorrent(data.id, { done: true, status: 'Completed' });
  });

  // FitGirl Games Logic
  const gamesSearchInput = document.getElementById('gamesSearchInput');
  let gamesSearchTimeout;

  const closeGameInfoBtn = document.getElementById('closeGameInfoBtn');
  if (closeGameInfoBtn) {
    closeGameInfoBtn.addEventListener('click', () => {
      document.getElementById('gameInfoModal').style.display = 'none';
    });
  }

  if (refreshGamesBtn) {
    refreshGamesBtn.addEventListener('click', () => loadFitGirlGames());
    // Auto load on tab click
    document.querySelector('[data-tab="games"]').addEventListener('click', () => {
      if (gamesResults.children.length === 0 && (!gamesSearchInput.value || gamesSearchInput.value.trim() === '')) {
        loadFitGirlGames();
      }
    });
  }

  if (gamesSearchInput) {
    gamesSearchInput.addEventListener('input', (e) => {
      clearTimeout(gamesSearchTimeout);
      const query = e.target.value.trim();
      if (!query) {
        loadFitGirlGames(); // back to latest
        return;
      }
      
      gamesSearchTimeout = setTimeout(() => {
        loadFitGirlGames(query);
      }, 500); // 500ms debounce
    });
  }


  async function loadFitGirlGames(query = null) {
    const statusContainer = document.getElementById('gamesStatus');
    const statusText = document.getElementById('gamesStatusText');
    
    statusContainer.style.display = 'flex';
    if(statusContainer.querySelector('.loader-bar')) statusContainer.querySelector('.loader-bar').style.display = 'block';
    
    const finalMsg = query ? `Searching for "${query}"...` : 'Fetching latest games from Velox Database...';
    
    // Start the fake terminal server load, but DO NOT block the actual fetch
    simulateServerLoad(statusText, finalMsg);
    
    // We add a minimum 1.5s delay so the user actually sees the cool server animation
    const fetchPromise = query ? window.api.fitgirlSearch(query) : window.api.fitgirlFetch();
    const delayPromise = new Promise(r => setTimeout(r, 1500));
    
    try {
      const [games] = await Promise.all([fetchPromise, delayPromise]);
      
      if (games.length === 0) {
        statusContainer.style.display = 'flex';
        if(statusContainer.querySelector('.loader-bar')) statusContainer.querySelector('.loader-bar').style.display = 'none';
        statusText.textContent = 'No games found.';
      } else {
        statusContainer.style.display = 'none';
      }
      
      gamesResults.innerHTML = '';
      games.forEach(g => {
        const div = document.createElement('div');
        div.className = 'game-card';
        div.style.background = 'var(--velox-bg-card)';
        div.style.borderRadius = 'var(--velox-r-md)';
        div.style.overflow = 'hidden';
        div.style.display = 'flex';
        div.style.flexDirection = 'column';
        div.style.boxShadow = 'var(--velox-shadow-card)';
        div.style.transition = 'transform 0.2s, box-shadow 0.2s';
        
        div.onmouseover = () => {
           div.style.transform = 'translateY(-4px)';
           div.style.boxShadow = 'var(--velox-shadow-menu)';
        };
        div.onmouseout = () => {
           div.style.transform = 'none';
           div.style.boxShadow = 'var(--velox-shadow-card)';
        };

        const hasThumbnail = !!g.thumbnail;
        const defaultIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234a90e2' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='6' width='20' height='12' rx='4' ry='4'%3E%3C/rect%3E%3Cpath d='M6 12h4'%3E%3C/path%3E%3Cpath d='M8 10v4'%3E%3C/path%3E%3Ccircle cx='15' cy='13' r='1' fill='%234a90e2'%3E%3C/circle%3E%3Ccircle cx='18' cy='11' r='1' fill='%234a90e2'%3E%3C/circle%3E%3C/svg%3E";
        const imgUrl = hasThumbnail ? g.thumbnail : defaultIcon;
        const imgStyle = hasThumbnail 
          ? 'width: 100%; height: 100%; object-fit: cover; opacity: 0.9;'
          : 'width: 100%; height: 100%; object-fit: contain; padding: 40px; box-sizing: border-box; opacity: 0.7;';

        div.innerHTML = `
          <div style="position: relative; width: 100%; height: 130px; background: #0b0f19; border-bottom: 1px solid var(--velox-border);">
            <img src="${imgUrl}" alt="thumbnail" style="${imgStyle}" />
            <button class="info-btn" style="position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.6); color: white; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%; width: 26px; height: 26px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; font-family: monospace; font-size: 14px; transition: 0.2s;" onmouseover="this.style.background='rgba(0,0,0,0.9)'" onmouseout="this.style.background='rgba(0,0,0,0.6)'" title="View Game Info">i</button>
          </div>
          <div style="padding: 12px; display: flex; flex-direction: column; flex: 1; justify-content: space-between;">
            <h4 style="margin: 0 0 10px 0; color: var(--velox-text); font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">${g.title}</h4>
            <button class="primary-btn sm download-btn" style="width: 100%; font-weight: bold; border-radius: var(--velox-r-sm); font-size: 11px; padding: 6px;">DOWNLOAD</button>
          </div>
        `;
        
        div.querySelector('.download-btn').addEventListener('click', async (e) => {
          const btn = e.target;
          let magnet = g.magnet;
          
          if (!magnet && g.url) {
            btn.textContent = 'FETCHING...';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            try {
              magnet = await window.api.fitgirlGetMagnet(g.url);
            } catch (err) {}
            btn.disabled = false;
            btn.style.opacity = '1';
          }
          
          if (magnet) {
            btn.textContent = 'STARTING...';
            if (window.addTorrentFromAnywhere) {
              window.addTorrentFromAnywhere(magnet, g.title);
            }
            btn.textContent = 'ADDED ✓';
            btn.style.background = '#27ae60';
            setTimeout(() => {
              btn.textContent = 'DOWNLOAD';
              btn.style.background = '';
            }, 3000);
          } else {
            btn.textContent = 'NOT FOUND';
            btn.style.background = '#e74c3c';
            setTimeout(() => {
              btn.textContent = 'DOWNLOAD';
              btn.style.background = '';
            }, 3000);
          }
        });

        div.querySelector('.info-btn').addEventListener('click', async () => {
          const modal = document.getElementById('gameInfoModal');
          const titleEl = document.getElementById('gameInfoTitle');
          const contentEl = document.getElementById('gameInfoContent');
          
          if (modal) {
            titleEl.textContent = g.title;
            contentEl.textContent = 'Fetching information from Velox Database...';
            modal.style.display = 'flex';
            
            try {
              const info = await window.api.fitgirlGetInfo(g.url);
              contentEl.textContent = info;
            } catch (err) {
              contentEl.textContent = 'Failed to fetch information.';
            }
          }
        });

        gamesResults.appendChild(div);
      });
    } catch (err) {
      statusContainer.style.display = 'flex';
      if(statusContainer.querySelector('.loader-bar')) statusContainer.querySelector('.loader-bar').style.display = 'none';
      statusText.textContent = 'Failed to load games. Check your internet connection.';
    }
  }

  // Audio & Notification System
  function playNotification() {
    if (notificationSound) {
      notificationSound.currentTime = 0;
      notificationSound.play().catch(e => console.warn('Audio play prevented:', e));
    }
  }

  function showNativeNotification(title, body) {
    new Notification(title, { body });
  }

  // Hook into existing download completions
  window.api.onDone((data) => {
    if (data.ok) {
      playNotification();
      showNativeNotification('Download Complete', 'Your file has finished downloading.');
    }
  });
});
function bytesToSize(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
}


