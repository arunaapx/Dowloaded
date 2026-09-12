// Playlist and channel links.
//
// The engine could always do this — buildArgs drops --no-playlist when a job
// carries isPlaylist — but nothing ever set the flag, so pasting a playlist
// downloaded exactly one video and gave no sign that the rest existed.
//
// Rather than hand yt-dlp the whole playlist as one job, the index is read
// first and each chosen video is queued as its own job. That way every video
// gets its own card, its own retry, and its own place in the queue, instead of
// forty videos hiding behind a single progress bar.

(function () {
  const modal = document.getElementById('playlistModal');
  if (!modal) return;

  const els = {
    title: document.getElementById('playlistTitle'),
    sub: document.getElementById('playlistSub'),
    list: document.getElementById('playlistList'),
    all: document.getElementById('playlistAll'),
    from: document.getElementById('playlistFrom'),
    to: document.getElementById('playlistTo'),
    applyRange: document.getElementById('playlistApplyRange'),
    ownFolder: document.getElementById('playlistFolder'),
    picked: document.getElementById('playlistPicked'),
    cancel: document.getElementById('playlistCancel'),
    close: document.getElementById('playlistClose'),
    video: document.getElementById('playlistVideo'),
    audio: document.getElementById('playlistAudio'),
  };

  let current = null;   // the playlist being shown

  // A link is worth asking about when it names a playlist or a channel. Mixes
  // (list=RD…) are generated endlessly, so they are read but capped.
  function looksLikePlaylist(url) {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) return false;
    if (u.searchParams.has('list')) return true;
    return /^\/(playlist|@[^/]+|c\/|channel\/|user\/)/.test(u.pathname);
  }

  function fmtDuration(sec) {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    if (!n) return '';
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Windows rejects these outright, and a stray one turns the whole download
  // into "could not open file for writing" with no clue why.
  function safeFolderName(name) {
    return String(name || 'Playlist')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')          // Windows also refuses trailing dots
      .slice(0, 60) || 'Playlist';
  }

  function rows() {
    return [...els.list.querySelectorAll('.pl-row')];
  }

  function pickedRows() {
    return rows().filter((r) => r.querySelector('input').checked);
  }

  function refresh() {
    const all = rows();
    const picked = pickedRows();
    els.picked.textContent = picked.length
      ? `${picked.length} of ${all.length} selected`
      : 'Nothing selected';
    els.video.disabled = picked.length === 0;
    els.audio.disabled = picked.length === 0;
    if (els.all) {
      els.all.checked = all.length > 0 && picked.length === all.length;
      els.all.indeterminate = picked.length > 0 && picked.length < all.length;
    }
  }

  function render(info) {
    current = info;
    els.title.textContent = info.title || 'Playlist';
    const parts = [];
    if (info.uploader) parts.push(info.uploader);
    parts.push(`${info.entries.length} video${info.entries.length === 1 ? '' : 's'}`);
    if (info.truncated) parts.push(`first ${info.entries.length} only`);
    els.sub.textContent = parts.join(' · ');

    els.from.value = '1';
    els.to.value = String(info.entries.length);
    els.to.max = String(info.entries.length);
    els.from.max = String(info.entries.length);

    els.list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of info.entries) {
      const row = document.createElement('label');
      row.className = 'pl-row' + (e.unavailable ? ' unavailable' : '');
      row.dataset.index = String(e.index);
      const dur = fmtDuration(e.duration);
      row.innerHTML = `
        <input type="checkbox" ${e.unavailable ? '' : 'checked'} ${e.unavailable ? 'disabled' : ''} />
        <span class="pl-num">${e.index}</span>
        <span class="pl-title"></span>
        <span class="pl-dur">${dur}</span>
      `;
      row.querySelector('.pl-title').textContent = e.unavailable
        ? `${e.title} — unavailable`
        : e.title;
      row.querySelector('input').addEventListener('change', refresh);
      frag.appendChild(row);
    }
    els.list.appendChild(frag);
    refresh();
  }

  function open() { modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); current = null; }

  function applyRange() {
    const from = Math.max(1, parseInt(els.from.value, 10) || 1);
    const to = Math.max(from, parseInt(els.to.value, 10) || from);
    rows().forEach((r) => {
      const box = r.querySelector('input');
      if (box.disabled) return;                 // unavailable entries stay off
      const i = Number(r.dataset.index);
      box.checked = i >= from && i <= to;
    });
    refresh();
  }

  function start(mode) {
    if (!current) return;
    const picked = pickedRows().map((r) => Number(r.dataset.index));
    if (!picked.length) return;

    const chosen = current.entries.filter((e) => picked.includes(e.index));
    const useFolder = els.ownFolder.checked;
    const folderName = safeFolderName(current.title);
    // Width follows the playlist, so 9 videos number 1..9 and 120 number
    // 001..120 rather than sorting as 1, 10, 100, 11.
    const width = String(current.entries.length).length;

    const previousMode = state.mode;
    state.mode = mode;
    try {
      for (const e of chosen) {
        const extra = {};
        if (useFolder) {
          const n = String(e.index).padStart(width, '0');
          extra.playlistFolder = folderName;
          extra.playlistPrefix = `${n} - `;
        }
        try { queueDownload(e.url, extra); } catch (err) { /* keep the rest going */ }
      }
    } finally {
      state.mode = previousMode;
    }

    close();
    if (typeof openTab === 'function') openTab('new');
  }

  els.all.addEventListener('change', () => {
    rows().forEach((r) => {
      const box = r.querySelector('input');
      if (!box.disabled) box.checked = els.all.checked;
    });
    refresh();
  });
  els.applyRange.addEventListener('click', applyRange);
  els.to.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRange(); });
  els.from.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRange(); });
  els.cancel.addEventListener('click', close);
  els.close.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
  els.video.addEventListener('click', () => start('video'));
  els.audio.addEventListener('click', () => start('audio'));

  // Called by the Start button before it queues anything. Returns true when the
  // picker took over, false when this is an ordinary single video.
  window.maybeOpenPlaylist = async function maybeOpenPlaylist(url) {
    if (!looksLikePlaylist(url) || !window.api?.playlistInfo) return false;

    const btn = document.getElementById('startBtn');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Reading playlist…'; }
    try {
      const info = await window.api.playlistInfo(url, 200);
      if (!info || !info.ok || !info.isPlaylist || !info.entries || !info.entries.length) return false;
      // A link that carries both a video id and a list is usually someone
      // sharing one video from a playlist, so offer the choice rather than
      // assuming the whole list.
      render(info);
      open();
      return true;
    } catch {
      return false;                              // fall through to a normal download
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  };
})();
