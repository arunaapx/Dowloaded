const BRIDGE = 'http://127.0.0.1:47813';
const $ = (id) => document.getElementById(id);

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

  $('dlPage').addEventListener('click', () => sendCurrent('video'));
  $('dlMp3').addEventListener('click', () => sendCurrent('audio'));

  await probe();
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
  }
}

async function sendCurrent(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  const status = $('status');
  status.textContent = 'Sending…';
  status.className = 'status checking';
  try {
    const res = await fetch(`${BRIDGE}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: tab.url,
        mode,
        quality: $('quality').value,
        audioBitrate: $('audioBitrate').value,
      }),
    });
    if (!res.ok) throw new Error('bad status');
    status.textContent = 'Sent to Velox ✓';
    status.className = 'status ok';
    setTimeout(() => window.close(), 700);
  } catch {
    status.textContent = 'Could not reach app.';
    status.className = 'status err';
  }
}
