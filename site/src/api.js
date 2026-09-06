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
  stats: () => get('/api/store/stats'),
  countDownload: () => post('/api/store/downloads'),

  createOrder: (email) => post('/api/store/orders', { email }),
  captureOrder: (orderId) => post('/api/store/orders/capture', { orderId }),

  adminLogin: (password) => post('/api/store/admin/login', { password }),
  adminCheck: (token) => post('/api/store/admin/check', { token }),
  adminLogout: (token) => post('/api/store/admin/logout', { token }),
  adminSave: (token, content) => post('/api/store/admin/content', { token, content }),
  adminOrders: (token) => post('/api/store/admin/orders', { token }),
};

// Load the PayPal SDK once, on demand. It is only fetched when a visitor
// actually reaches the checkout, so it costs the landing page nothing.
let paypalPromise = null;
export function loadPayPal(clientId, currency) {
  if (paypalPromise) return paypalPromise;
  paypalPromise = new Promise((resolve, reject) => {
    if (window.paypal) return resolve(window.paypal);
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency || 'USD')}&intent=capture`;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK did not load')));
    s.onerror = () => reject(new Error('Could not reach PayPal'));
    document.head.appendChild(s);
  });
  return paypalPromise;
}

// "Windows" / "macOS" / "Linux" - used for the nav badge and the hero button.
export function detectOS() {
  const p = (navigator.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac')) return 'macOS';
  if (p.includes('linux') || p.includes('x11')) return 'Linux';
  return 'Windows';
}
