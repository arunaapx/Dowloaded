// Every call the site makes to the Rust store API. Same origin in production
// (nginx proxies /api), proxied by Vite in development.

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function get(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  content: () => get('/api/store/content'),
  // The pricing tiers, straight from the licence server's admin panel — the
  // same list the desktop app shows, so a price is edited in one place only.
  plans: () => get('/api/plans'),
  stats: () => get('/api/store/stats'),
  countDownload: () => post('/api/store/downloads'),

  // PayHere: we ask the server to sign a checkout, then post the browser to it.
  startCheckout: (email) => post('/api/store/payhere/start', { email }),
  checkoutResult: (orderId) => post('/api/store/payhere/result', { orderId }),

  adminLogin: (password) => post('/api/store/admin/login', { password }),
  adminCheck: (token) => post('/api/store/admin/check', { token }),
  adminLogout: (token) => post('/api/store/admin/logout', { token }),
  adminSave: (token, content) => post('/api/store/admin/content', { token, content }),
  adminSetDownloads: (token, downloads) => post('/api/store/admin/downloads', { token, downloads }),
  adminOrders: (token) => post('/api/store/admin/orders', { token }),
};

// PayHere needs no SDK: checkout is a signed form post, so there is no
// third-party script on the page at all.
export function submitCheckout(action, fields) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v == null ? '' : String(v);
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
// "Windows" / "macOS" / "Linux" - used for the nav badge and the hero button.
export function detectOS() {
  const p = (navigator.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac')) return 'macOS';
  if (p.includes('linux') || p.includes('x11')) return 'Linux';
  return 'Windows';
}
