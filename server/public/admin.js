const $ = (id) => document.getElementById(id);
let allKeys = [];
let editingKey = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('401'); }
  return await res.json().catch(() => ({}));
}

async function loadAll() {
  const k = await api('/admin/api/keys');
  allKeys = k.keys || [];
  renderStats();
  renderKeys();

  const s = await api('/admin/api/settings');
  renderSettings(s.settings || {});

  const d = await api('/admin/api/devices');
  renderDevices(d.devices || []);

  const ev = await api('/admin/api/events');
  renderEvents(ev.events || []);
}

// ---------- free-trial settings ----------

function renderSettings(s) {
  $('setSignup').value = s.signupEnabled ? '1' : '0';
  $('setTrial').value = s.trialDownloads;
  $('setDays').value = s.defaultLicenseDays;
  const badge = $('signupState');
  badge.textContent = s.signupEnabled
    ? `Open — ${s.trialDownloads} free downloads per device`
    : 'Closed — purchase only';
  badge.className = s.signupEnabled ? 'hint ok' : 'hint warn';
}

// ---------- devices: what the hardware lock holds ----------

function renderDevices(devices) {
  const tbody = $('devicesBody');
  tbody.innerHTML = '';
  if (!devices.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">No devices registered yet.</td></tr>';
    return;
  }
  for (const d of devices) {
    const tr = document.createElement('tr');
    const used = d.trialDownloads || 0;
    tr.innerHTML = `
      <td class="device"><small>${escape(d.deviceId).slice(0, 20)}…</small></td>
      <td>${escape(d.email || '')}<br/><small class="device">${d.email ? '' : 'unbound'}</small></td>
      <td class="key">${d.key ? escape(d.key) : '—'}</td>
      <td>${used} / ${used + (d.trialRemaining || 0)}</td>
      <td>${d.boundAt ? fmtDate(d.boundAt) : '—'}</td>
      <td class="actions">
        <button class="btn small ghost" data-dact="reset-trial">Reset trial</button>
        ${d.email ? '<button class="btn small ghost" data-dact="unbind">Unbind</button>' : ''}
        <button class="btn small danger" data-dact="delete">Delete</button>
      </td>
    `;
    tr.querySelectorAll('button[data-dact]').forEach((b) => {
      b.addEventListener('click', () => handleDeviceAction(b.dataset.dact, d));
    });
    tbody.appendChild(tr);
  }
}

async function handleDeviceAction(act, d) {
  const id = encodeURIComponent(d.deviceId);
  if (act === 'reset-trial') {
    if (!confirm(`Give this machine its ${d.trialDownloads || 0} used free downloads back?`)) return;
    await api(`/admin/api/devices/${id}/reset-trial`, { method: 'POST' });
  }
  if (act === 'unbind') {
    if (!confirm(`Unbind ${d.email} from this machine?\n\nThey can then activate on a new one, and this machine is free for another account. The trial count is kept.`)) return;
    await api(`/admin/api/devices/${id}/unbind`, { method: 'POST' });
  }
  if (act === 'delete') {
    if (!confirm('Forget this device completely?\n\nThis also clears its trial count, so it can claim a fresh free trial.')) return;
    await api(`/admin/api/devices/${id}`, { method: 'DELETE' });
  }
  await loadAll();
}

function renderStats() {
  const total = allKeys.length;
  const active = allKeys.filter((k) => k.status === 'active').length;
  const blocked = allKeys.filter((k) => k.status === 'blocked').length;
  const expired = allKeys.filter((k) => k.status === 'expired').length;
  const revoked = allKeys.filter((k) => k.status === 'revoked').length;
  const pending = allKeys.filter((k) => k.status === 'pending').length;
  $('stTotal').textContent = total;
  $('stActive').textContent = active;
  $('stBlocked').textContent = blocked;
  $('stExpired').textContent = expired;
  $('stRevoked').textContent = revoked;
  $('stPending').textContent = pending;
}

function renderKeys() {
  const filter = $('filterInput').value.toLowerCase().trim();
  const tbody = $('keysBody');
  tbody.innerHTML = '';
  const list = filter
    ? allKeys.filter((k) =>
        (k.key + ' ' + (k.email || '') + ' ' + (k.device_name || '') + ' ' + (k.device_id || '') + ' ' + (k.note || ''))
          .toLowerCase()
          .includes(filter)
      )
    : allKeys;

  for (const k of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="key">${escape(k.key)}</td>
      <td>${escape(k.email || '')}<br/><small class="device">${escape(k.note || '')}</small></td>
      <td class="expiry">${formatExpiry(k)}</td>
      <td class="device">${escape(k.device_name || '')}${k.device_id ? `<br/><small>${escape(k.device_id).slice(0,16)}...</small>` : ''}</td>
      <td>${trialCell(k)}</td>
      <td>${fmtDate(k.created_at)}</td>
      <td>${fmtDate(k.last_heartbeat)}</td>
      <td>${statusBadge(k.status)}</td>
      <td class="actions">
        <button class="btn small ghost" data-act="copy">Copy</button>
        <button class="btn small ghost" data-act="edit">Edit</button>
        <button class="btn small ghost" data-act="extend">+30d</button>
        ${k.device_id ? '<button class="btn small ghost" data-act="reset">Reset device</button>' : ''}
        ${k.trial ? '<button class="btn small ghost" data-act="make-paid" title="Lift the free-download cap for good">Make paid</button>' : ''}
        ${k.blocked
          ? '<button class="btn small ghost" data-act="unblock">Unblock</button>'
          : '<button class="btn small danger" data-act="block">Block</button>'}
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

function statusBadge(status) {
  const s = status || 'pending';
  const label = s[0].toUpperCase() + s.slice(1);
  return `<span class="badge ${escape(s)}">${escape(label)}</span>`;
}

// Paid keys have no cap; trial keys show how much of the free quota the bound
// machine has spent, and turn amber once it is gone.
function trialCell(k) {
  if (!k.trial) return '<span class="badge ok">Paid</span>';
  const used = k.trial_used || 0;
  const total = k.trial_total || 0;
  const spent = total && used >= total;
  return `<span class="badge ${spent ? 'warn' : ''}">${used} / ${total}</span>`;
}

function formatExpiry(k) {
  if (!k.expires_at) return '<span style="color:var(--text-faint)">Lifetime</span>';
  const d = new Date(k.expires_at);
  const days = typeof k.days_remaining === 'number' ? k.days_remaining : Math.max(0, Math.ceil((k.expires_at - Date.now()) / 86400000));
  return `${escape(d.toLocaleDateString())}<br/><small class="device">${days} day${days === 1 ? '' : 's'} left</small>`;
}

function renderEvents(list) {
  const tbody = $('eventsBody');
  tbody.innerHTML = '';
  for (const e of list) {
    const tr = document.createElement('tr');
    const cls = e.type.includes('block') ? 'blocked' : e.type.includes('expired') ? 'expired' : e.type.includes('revoked') ? 'revoked' : e.type.startsWith('admin') ? 'pending' : 'active';
    tr.innerHTML = `
      <td>${fmtDate(e.at)}</td>
      <td><span class="badge ${cls}">${escape(e.type)}</span></td>
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
  if (act === 'edit') {
    openEdit(k);
    return;
  }
  if (act === 'extend') {
    const days = Number(prompt(`Extend ${k.key} by how many days?`, '30'));
    if (!Number.isFinite(days) || days <= 0) return;
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/extend`, { method: 'POST', body: { days } });
    loadAll();
    return;
  }
  if (act === 'block') {
    const reason = prompt(`Block ${k.key}? Reason shown in admin events:`, k.block_reason || '');
    if (reason === null) return;
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/block`, { method: 'POST', body: { reason } });
    loadAll();
    return;
  }
  if (act === 'unblock') {
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/unblock`, { method: 'POST' });
    loadAll();
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
  if (act === 'make-paid') {
    if (!confirm(`Turn ${k.key} into a paid key?\n\nThe free-download cap is lifted permanently. Use this when someone has paid you directly.`)) return;
    await api(`/admin/api/keys/${encodeURIComponent(k.key)}/make-paid`, { method: 'POST' });
    await loadAll();
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
  }
}

function openEdit(k) {
  editingKey = k.key;
  $('editKey').innerHTML = `<code>${escape(k.key)}</code>`;
  $('editEmail').value = k.email || '';
  $('editNote').value = k.note || '';
  $('editExpiry').value = k.expires_at ? toDateInput(k.expires_at) : '';
  $('editResult').textContent = '';
  $('editModal').classList.remove('hidden');
}

$('settingsSave').addEventListener('click', async () => {
  const out = $('settingsResult');
  out.textContent = 'Saving…';
  out.className = 'hint';
  try {
    const res = await api('/admin/api/settings', {
      method: 'POST',
      body: {
        signupEnabled: $('setSignup').value === '1',
        trialDownloads: Number($('setTrial').value),
        defaultLicenseDays: Number($('setDays').value),
      },
    });
    // api() resolves with the body on failure rather than throwing, so the
    // server's own message is what the admin sees.
    if (!res.ok) {
      out.textContent = res.error || 'Could not save.';
      out.className = 'hint warn';
      return;
    }
    renderSettings(res.settings || {});
    out.textContent = 'Saved. This takes effect immediately.';
    out.className = 'hint ok';
    await loadAll();
  } catch (e) {
    out.textContent = e.message || 'Could not save.';
    out.className = 'hint warn';
  }
});

$('refreshBtn').addEventListener('click', loadAll);
$('filterInput').addEventListener('input', renderKeys);
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin-logout', { method: 'POST', credentials: 'include' });
  location.href = '/login';
});

$('createBtn').addEventListener('click', () => {
  $('createEmail').value = '';
  $('createNote').value = '';
  $('createDays').value = '30';
  $('createResult').textContent = '';
  $('createModal').classList.remove('hidden');
});
$('createCancel').addEventListener('click', () => $('createModal').classList.add('hidden'));
$('createOk').addEventListener('click', async () => {
  const email = $('createEmail').value.trim();
  const note  = $('createNote').value.trim();
  const days = Number($('createDays').value || 0);
  const res = await api('/admin/api/keys', { method: 'POST', body: { email, note, days } });
  if (!res.ok) {
    $('createResult').textContent = res.error || 'Failed.';
    return;
  }
  $('createResult').innerHTML = `Created: <code>${escape(res.key)}</code>`;
  loadAll();
});

$('editCancel').addEventListener('click', () => $('editModal').classList.add('hidden'));
$('editLifetime').addEventListener('click', () => {
  $('editExpiry').value = '';
  $('editResult').textContent = 'Expiry cleared: lifetime license.';
});
$('editSave').addEventListener('click', async () => {
  if (!editingKey) return;
  const email = $('editEmail').value.trim();
  const note = $('editNote').value.trim();
  const expiresAt = $('editExpiry').value ? new Date($('editExpiry').value + 'T23:59:59.999').getTime() : null;
  const res = await api(`/admin/api/keys/${encodeURIComponent(editingKey)}`, {
    method: 'PATCH',
    body: { email, note, expiresAt },
  });
  if (!res.ok) {
    $('editResult').textContent = res.error || 'Failed.';
    return;
  }
  $('editModal').classList.add('hidden');
  loadAll();
});

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
function fmtDate(ms) {
  if (!ms) return '<span style="color:var(--text-faint)">-</span>';
  const d = new Date(ms);
  const now = Date.now();
  const diff = (now - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleString();
}
function toDateInput(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

loadAll();
setInterval(loadAll, 30000);
