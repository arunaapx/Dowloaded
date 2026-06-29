const BRIDGE = 'http://127.0.0.1:47813';
const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  detection: null,
};

(async function init() {
  const opts = await chrome.storage.local.get({ quality: '1080p', audioBitrate: '192' });
  $('quality').value = opts.quality;
  $('audioBitrate').value = opts.audioBitrate;

  $('quality').addEventListener('change', (e) =>
    chrome.storage.local.set({ quality: e.target.value })
  );
  $('audioBitrate').addEventListener('change', (e) =>
    chrome.storage.local.set({ audioBitrate: e.target.value })
  );

  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $('dlPage').addEventListener('click', () => sendCurrent('video'));
  $('dlMp3').addEventListener('click', () => sendCurrent('audio'));
  $('dlDetected').addEventListener('click', () => sendDetected('video'));

  await probe();
  await loadDetected();
})();

async function probe() {
  const status = $('status');
  try {
    const res = await fetch(`${BRIDGE}/ping`);
    const j = await res.json();
    if (j.ok) {
      status.textContent = `Connected: ${j.name} v${j.version}`;
      status.className = 'status ok';
    }
  } catch {
    status.textContent = 'Velox app not running. Open the desktop app.';
    status.className = 'status err';
    $('dlPage').disabled = true;
    $('dlMp3').disabled = true;
    $('dlDetected').disabled = true;
  }
}

function queryContent(tabId) {
  return new Promise((resolve) => {
    if (!tabId) return resolve(null);
    chrome.tabs.sendMessage(tabId, { type: 'velox-get-candidates' }, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp || null);
    });
  });
}

async function loadDetected() {
  const data = await queryContent(state.tab?.id);
  state.detection = data;
  renderDetected(data);
}

function renderDetected(data) {
  const list = $('detectedList');
  const count = $('detectedCount');
  const button = $('dlDetected');
  list.textContent = '';

  const items = data?.candidates || [];
  count.textContent = items.length ? `${items.length} found` : 'None';
  button.disabled = !items.length || $('dlPage').disabled;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'detected-empty';
    empty.textContent = data ? 'No direct media found yet. Use Download this page.' : 'Cannot scan this tab.';
    list.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'detected-item';
    row.tabIndex = 0;
    row.title = 'Send this detected media to Velox';
    const title = document.createElement('div');
    title.className = 'detected-title';
    title.textContent = item.title || item.type || 'Detected media';
    const meta = document.createElement('div');
    meta.className = 'detected-meta';
    meta.textContent = `${item.type || 'Video'} · ${item.source || 'detected'} · ${hostOf(item.url)}`;
    row.append(title, meta);
    row.addEventListener('click', () => sendPayload(payloadFromCandidate(item, 'video')));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        sendPayload(payloadFromCandidate(item, 'video'));
      }
    });
    list.appendChild(row);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function bestPayload(mode) {
  const best = state.detection?.candidates?.[0];
  return payloadFromCandidate(best, mode);
}

function payloadFromCandidate(candidate, mode) {
  const pageUrl = state.detection?.pageUrl || state.tab?.url || '';
  const usePage = state.detection?.prefersPageUrl || !candidate?.url;
  const url = usePage ? pageUrl : candidate.url;
  return {
    url,
    mode,
    quality: $('quality').value,
    audioBitrate: $('audioBitrate').value,
    referer: url === pageUrl ? '' : pageUrl,
    sourcePage: pageUrl,
    detectedUrl: candidate?.url || '',
    title: candidate?.title || state.tab?.title || '',
  };
}

async function sendCurrent(mode) {
  if (!state.tab?.url) return;
  await sendPayload({
    url: state.tab.url,
    mode,
    quality: $('quality').value,
    audioBitrate: $('audioBitrate').value,
    sourcePage: state.tab.url,
    title: state.tab.title || '',
  });
}

async function sendDetected(mode) {
  const payload = bestPayload(mode);
  if (!payload.url) return;
  await sendPayload(payload);
}

async function sendPayload(payload) {
  const status = $('status');
  status.textContent = 'Sending...';
  status.className = 'status checking';
  try {
    const res = await fetch(`${BRIDGE}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('bad status');
    status.textContent = 'Sent to Velox';
    status.className = 'status ok';
    setTimeout(() => window.close(), 700);
  } catch {
    status.textContent = 'Could not reach app.';
    status.className = 'status err';
  }
}
