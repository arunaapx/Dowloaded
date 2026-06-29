const BRIDGE = 'http://127.0.0.1:47813';

const MENUS = [
  { id: 'velox-page',  title: 'Download this page with Velox',   contexts: ['page', 'frame'] },
  { id: 'velox-link',  title: 'Download link with Velox',         contexts: ['link'] },
  { id: 'velox-media', title: 'Download video/audio with Velox',  contexts: ['video', 'audio'] },
  { id: 'velox-sep',   type: 'separator',                          contexts: ['page', 'frame', 'link', 'video', 'audio'] },
  { id: 'velox-mp3',   title: 'Download as MP3',                   contexts: ['page', 'frame', 'link'] },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) chrome.contextMenus.create(m);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url = '';
  let mode = 'video';
  switch (info.menuItemId) {
    case 'velox-page':  url = info.pageUrl;            break;
    case 'velox-link':  url = info.linkUrl;            break;
    case 'velox-media': url = info.srcUrl || info.pageUrl; break;
    case 'velox-mp3':   url = info.linkUrl || info.pageUrl; mode = 'audio'; break;
    default: return;
  }
  if (!url) return;

  const opts = await chrome.storage.local.get({ quality: '1080p', audioBitrate: '192' });
  await sendToApp({
    url,
    mode,
    quality: opts.quality,
    audioBitrate: opts.audioBitrate,
    referer: url === info.pageUrl ? '' : (info.pageUrl || tab?.url || ''),
    sourcePage: info.pageUrl || tab?.url || '',
    detectedUrl: info.srcUrl || info.linkUrl || '',
    title: tab?.title || '',
  });
});

async function sendToApp(payload) {
  try {
    const res = await fetch(`${BRIDGE}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      flashBadge('!', '#ef4444');
      return { ok: false, error: `server returned ${res.status}` };
    }
    flashBadge('✓', '#22c55e');
    return { ok: true };
  } catch (e) {
    flashBadge('!', '#ef4444');
    return { ok: false, error: 'app-not-running' };
  }
}

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'velox-send') {
    sendToApp(msg.payload).then((result) => sendResponse(result));
    return true;
  }
  if (msg?.type === 'velox-ping') {
    fetch(`${BRIDGE}/ping`)
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, info: j }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
