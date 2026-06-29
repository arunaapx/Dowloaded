// Velox Downloader PWA — talks to the Phase 2 web API.

const $ = (id) => document.getElementById(id);

const state = {
  mode: 'video',
  quality: '1080p',
  aFormat: 'mp3',
  jobId: null,
  es: null,
};

// ---------- option pickers ----------

$('modeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  document.querySelectorAll('#modeSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  $('videoOptions').hidden = state.mode !== 'video';
  $('audioOptions').hidden = state.mode !== 'audio';
});

function wireChips(containerId, key, attr) {
  $(containerId).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state[key] = chip.dataset[attr];
    $(containerId).querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  });
}
wireChips('qualityChips', 'quality', 'q');
wireChips('aFormatChips', 'aFormat', 'af');

// ---------- paste ----------

$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $('url').value = text.trim();
  } catch {
    $('url').focus();
  }
});

// ---------- download flow ----------

$('downloadBtn').addEventListener('click', startDownload);

async function startDownload() {
  const url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    flashLog('Enter a valid http(s) link.', true);
    return;
  }

  const payload = { url, mode: state.mode };
  if (state.mode === 'video') payload.quality = state.quality;
  else payload.aFormat = state.aFormat;

  setBusy(true);
  resetProgress();
  $('progressCard').hidden = false;
  $('progressTitle').textContent = 'Starting…';

  try {
    const res = await fetch('api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'failed to start');
    state.jobId = data.id;
    listen(data.id);
  } catch (err) {
    setBusy(false);
    $('progressTitle').textContent = 'Failed';
    flashLog(err.message, true);
  }
}

function listen(id) {
  if (state.es) state.es.close();
  const es = new EventSource(`api/jobs/${id}/events`);
  state.es = es;

  es.addEventListener('update', (e) => {
    const d = JSON.parse(e.data);
    $('progressTitle').textContent =
      d.status === 'queued' ? 'Queued…' :
      d.status === 'running' ? 'Downloading…' :
      d.status === 'done' ? 'Done' : 'Processing…';
    const pct = Math.round(d.percent || 0);
    $('barFill').style.width = pct + '%';
    $('pctText').textContent = pct + '%';
    $('speedText').textContent = d.speed || '';
    $('etaText').textContent = d.eta ? 'ETA ' + d.eta : '';
  });

  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    if (d.message) flashLog(d.message, !!d.error);
  });

  es.addEventListener('end', (e) => {
    const d = JSON.parse(e.data);
    es.close();
    state.es = null;
    setBusy(false);
    if (d.status === 'done') {
      finishOk(id, d.filename);
    } else {
      $('progressTitle').textContent = 'Failed';
      flashLog(d.error || 'Download failed.', true);
    }
  });

  es.onerror = () => {
    // network blip — EventSource auto-retries; poll once as a fallback.
    pollOnce(id);
  };
}

async function pollOnce(id) {
  try {
    const r = await fetch(`api/jobs/${id}`);
    const d = await r.json();
    if (d.ok && d.status === 'done') { if (state.es) state.es.close(); finishOk(id, d.filename); }
  } catch {}
}

function finishOk(id, filename) {
  $('barFill').style.width = '100%';
  $('pctText').textContent = '100%';
  $('progressTitle').textContent = 'Ready';
  flashLog(filename ? `Saved: ${filename}` : 'File ready.', false);
  const link = $('saveLink');
  link.href = `api/jobs/${id}/file`;
  if (filename) link.setAttribute('download', filename);
  link.hidden = false;
  // Auto-trigger the browser's save dialog.
  link.click();
}

$('cancelBtn').addEventListener('click', async () => {
  if (state.es) { state.es.close(); state.es = null; }
  if (state.jobId) {
    try { await fetch(`api/jobs/${state.jobId}/cancel`, { method: 'POST' }); } catch {}
  }
  setBusy(false);
  $('progressTitle').textContent = 'Cancelled';
});

// ---------- ui helpers ----------

function setBusy(busy) {
  $('downloadBtn').disabled = busy;
  $('downloadBtn').textContent = busy ? 'Working…' : 'Download';
}
function resetProgress() {
  $('barFill').style.width = '0%';
  $('pctText').textContent = '0%';
  $('speedText').textContent = '';
  $('etaText').textContent = '';
  $('logLine').textContent = '';
  $('saveLink').hidden = true;
}
function flashLog(msg, isError) {
  const el = $('logLine');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

// ---------- PWA install + service worker ----------

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
