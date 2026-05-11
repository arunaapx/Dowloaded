const $ = (id) => document.getElementById(id);
let allKeys = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('401'); }
  const json = await res.json().catch(() => ({}));
  return json;
}

async function loadAll() {
  const k = await api('/admin/api/keys');
  allKeys = k.keys || [];
  renderStats();
  renderKeys();
  const ev = await api('/admin/api/events');
  renderEvents(ev.events || []);
}

function renderStats() {
  const total = allKeys.length;
  const revoked = allKeys.filter((k) => k.revoked).length;
  const active = allKeys.filter((k) => !k.revoked && k.device_id).length;
  const pending = allKeys.filter((k) => !k.revoked && !k.device_id).length;
  $('stTotal').textContent = total;
  $('stActive').textContent = active;
  $('stRevoked').textContent = revoked;
  $('stPending').textContent = pending;
}

function renderKeys() {
  const filter = $('filterInput').value.toLowerCase().trim();
  const tbody = $('keysBody');
  tbody.innerHTML = '';
  const list = filter
    ? allKeys.filter((k) =>
        (k.key + ' ' + (k.email || '') + ' ' + (k.device_name || '') + ' ' + (k.device_id || ''))
          .toLowerCase()
          .includes(filter)
      )
    : allKeys;
  for (const k of list) {
    const tr = document.createElement('tr');
    const status = k.revoked
      ? '<span class="badge revoked">Revoked</span>'
      : k.device_id
        ? '<span class="badge active">Active</span>'
        : '<span class="badge pending">Pending</span>';
    tr.innerHTML = `
      <td class="key">${escape(k.key)}</td>
      <td>${escape(k.email || '')}</td>
      <td class="device">${escape(k.device_name || '')}${k.device_id ? `<br/><small style="opacity:0.6">${escape(k.device_id).slice(0,16)}…</small>` : ''}</td>
      <td>${fmtDate(k.created_at)}</td>
      <td>${fmtDate(k.last_heartbeat)}</td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn small ghost" data-act="copy">Copy</button>
        ${k.device_id ? '<button class="btn small ghost" data-act="reset">Reset device</button>' : ''}
        ${k.revoked
          ? '<button class="btn small ghost" data-act="unrevoke">Unrevoke</button>'
          : '<button class="btn small danger" data-act="revoke">Revoke</button>'}
        <button class="btn small danger" data-act="delete">Delete</button>
      </td>
    `;
    tr.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => handleAction(b.dataset.act, k));
    });
    tbody.appendChild(tr);
  }
}

function renderEvents(list) {
  const tbody = $('eventsBody');
  tbody.innerHTML = '';
  for (const e of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(e.at)}</td>
      <td><span class="badge ${e.type.startsWith('admin') ? 'pending' : (e.type.includes('revoked') ? 'revoked' : 'active')}">${escape(e.type)}</span></td>
      <td class="key">${escape(e.key || '')}</td>
      <td class="device">${escape(e.ip || '')}</td>
      <td class="device">${escape(e.detail || '')}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function handleAction(act, k) {
  if (act === 'copy') {
    navigator.clipboard.writeText(k.key);
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete ${k.key}? This removes it entirely.`)) return;
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}`, { method: 'DELETE' });
    loadAll();
    return;
  }
  if (act === 'revoke') {
    if (!confirm(`Revoke ${k.key}? Client will lock on next heartbeat.`)) return;
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/revoke`, { method: 'POST' });
    loadAll();
    return;
  }
  if (act === 'unrevoke') {
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/unrevoke`, { method: 'POST' });
    loadAll();
    return;
  }
  if (act === 'reset') {
    if (!confirm(`Reset device binding for ${k.key}? User can reactivate on a new device.`)) return;
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/reset-device`, { method: 'POST' });
    loadAll();
    return;
  }
}

$('refreshBtn').addEventListener('click', loadAll);
$('filterInput').addEventListener('input', renderKeys);
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin-logout', { method: 'POST', credentials: 'include' });
  location.href = '/login';
});

$('createBtn').addEventListener('click', () => {
  $('createEmail').value = '';
  $('createNote').value = '';
  $('createResult').textContent = '';
  $('createModal').classList.remove('hidden');
});
$('createCancel').addEventListener('click', () => $('createModal').classList.add('hidden'));
$('createOk').addEventListener('click', async () => {
  const email = $('createEmail').value.trim();
  const note  = $('createNote').value.trim();
  const res = await api('/admin/api/keys', { method: 'POST', body: { email, note } });
  if (!res.ok) {
    $('createResult').textContent = res.error || 'Failed.';
    return;
  }
  $('createResult').innerHTML = `Created: <code>${escape(res.key)}</code>`;
  loadAll();
});

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
function fmtDate(ms) {
  if (!ms) return '<span style="color:var(--text-faint)">—</span>';
  const d = new Date(ms);
  const now = Date.now();
  const diff = (now - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleString();
}

loadAll();
setInterval(loadAll, 30000);
