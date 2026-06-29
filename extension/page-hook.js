(() => {
  if (window.__veloxMediaHook) return;
  window.__veloxMediaHook = true;

  const MEDIA_RE = /\.(?:m3u8|mpd|mp4|m4v|webm|mov|ts)(?:[?#]|$)/i;
  const emit = (url, source) => {
    if (typeof url !== 'string' || !MEDIA_RE.test(url)) return;
    window.postMessage({ source: 'velox-page-hook', url, via: source || 'network' }, '*');
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function veloxFetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        emit(url, 'fetch');
      } catch {}
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function veloxOpen(method, url) {
    try { emit(url, 'xhr'); } catch {}
    return originalOpen.apply(this, arguments);
  };

  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function veloxSetAttribute(name, value) {
    if (/^(?:src|href)$/i.test(name)) {
      try { emit(String(value), 'attribute'); } catch {}
    }
    return originalSetAttribute.apply(this, arguments);
  };
})();
