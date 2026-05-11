(() => {
  if (window.__veloxInjected) return;
  window.__veloxInjected = true;

  const MIN_W = 240;
  const MIN_H = 150;
  const ATTR = 'data-velox-attached';

  const QUALITIES = [
    { label: '4K',     mode: 'video', quality: '4k'    },
    { label: '1080p',  mode: 'video', quality: '1080p' },
    { label: '720p',   mode: 'video', quality: '720p'  },
    { label: '480p',   mode: 'video', quality: '480p'  },
    { sep: true },
    { label: 'MP3 · 320 kbps', mode: 'audio', audioBitrate: '320' },
    { label: 'MP3 · 192 kbps', mode: 'audio', audioBitrate: '192' },
  ];

  const tracked = [];
  let toastEl = null;

  function svg(name) {
    const icons = {
      down: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      check: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      spin: `<svg class="velox-spin" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="14 36" stroke-linecap="round"/></svg>`,
      err: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 4v10M12 18v.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`,
    };
    return icons[name];
  }

  function buildButton() {
    const wrap = document.createElement('div');
    wrap.className = 'velox-dl-btn';
    wrap.innerHTML = `
      <div class="velox-pill" role="button" aria-label="Download with Velox" title="Download">
        <span class="velox-icon-slot">${svg('down')}</span>
        <span class="velox-label">Download</span>
        <span class="velox-caret">▾</span>
      </div>
      <div class="velox-menu" role="menu">
        ${QUALITIES.map((q) =>
          q.sep
            ? `<div class="velox-sep"></div>`
            : `<button class="velox-mi" data-mode="${q.mode}"${q.quality ? ` data-quality="${q.quality}"` : ''}${q.audioBitrate ? ` data-audio="${q.audioBitrate}"` : ''}>
                 <span class="velox-mi-ico">${q.mode === 'audio' ? '🎵' : '🎬'}</span>
                 <span class="velox-mi-label">${q.label}</span>
               </button>`
        ).join('')}
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
    toastEl._t = setTimeout(() => {
      toastEl.classList.remove('velox-toast-show');
    }, 2200);
  }

  function setState(btn, state) {
    const slot = btn.querySelector('.velox-icon-slot');
    const label = btn.querySelector('.velox-label');
    btn.classList.remove('velox-loading', 'velox-success', 'velox-error');
    if (state === 'loading') {
      btn.classList.add('velox-loading');
      slot.innerHTML = svg('spin');
      label.textContent = 'Sending…';
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
      label.textContent = 'Download';
    }
  }

  function attach(video) {
    if (video.hasAttribute(ATTR)) return;
    video.setAttribute(ATTR, '1');
    const btn = buildButton();
    const pill = btn.querySelector('.velox-pill');
    const menu = btn.querySelector('.velox-menu');

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.classList.toggle('velox-open');
    });

    menu.addEventListener('click', async (e) => {
      const mi = e.target.closest('.velox-mi');
      if (!mi) return;
      e.stopPropagation();
      e.preventDefault();
      btn.classList.remove('velox-open');

      const payload = {
        url: window.location.href,
        mode: mi.dataset.mode || 'video',
        quality: mi.dataset.quality || '1080p',
        audioBitrate: mi.dataset.audio || '192',
      };

      setState(btn, 'loading');
      const result = await send(payload);
      if (result.ok) {
        setState(btn, 'success');
        showToast(`Sent to Velox · ${mi.querySelector('.velox-mi-label').textContent}`, 'ok');
      } else {
        setState(btn, 'error');
        showToast(result.error?.includes('runtime') ? 'Reload the extension' : 'Velox app not running', 'err');
      }
      setTimeout(() => setState(btn, 'idle'), 2000);
    });

    document.addEventListener('click', (e) => {
      if (!btn.contains(e.target)) btn.classList.remove('velox-open');
    });

    // Show button while mouse is near the video or button
    let hideTimer = null;
    function reveal() {
      clearTimeout(hideTimer);
      btn.classList.add('velox-visible');
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!btn.classList.contains('velox-open')) {
          btn.classList.remove('velox-visible');
        }
      }, 1200);
    }
    video.addEventListener('mouseenter', reveal);
    video.addEventListener('mousemove', reveal);
    video.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('mouseenter', reveal);
    btn.addEventListener('mouseleave', scheduleHide);

    tracked.push({ video, btn });
  }

  function scan() {
    document.querySelectorAll('video').forEach((v) => {
      if (!v.hasAttribute(ATTR)) attach(v);
    });
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

  let raf = false;
  function schedule() {
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => { raf = false; position(); });
  }

  scan();
  schedule();

  const mo = new MutationObserver(() => { scan(); schedule(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule);
  setInterval(schedule, 600);

  console.log('[Velox] content script ready, watching for videos');
})();
