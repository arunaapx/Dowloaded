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

  await loadCookies();

  const d = await api('/admin/api/devices');
  renderDevices(d.devices || []);

  const ev = await api('/admin/api/events');
  renderEvents(ev.events || []);

  await loadPlans();
  await loadNotices();
}

// ---------- pricing plans ----------
//
// The whole table is edited as one list and saved in one request, which is what
// the server expects: a plan missing from the list is a plan that was deleted.

let plans = [];
const PLAN_PERIODS = ['', 'one time', 'per month', 'per year', 'per week'];

async function loadPlans() {
  const r = await api('/admin/api/plans');
  plans = r.plans || [];
  renderPlans();
}

function renderPlans() {
  const box = $('plansList');
  box.innerHTML = '';
  if (!plans.length) {
    box.innerHTML = '<div class="hint">No plans yet. Add one and the app will show it.</div>';
  }
  plans.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'plan-row';
    row.innerHTML = `
      <div class="plan-grid">
        <label><span class="setting-label">Name</span><input data-f="name" type="text" maxlength="60" /></label>
        <label><span class="setting-label">Price</span><input data-f="price" type="text" maxlength="40" placeholder="LKR 990" /></label>
        <label><span class="setting-label">Billing</span>
          <select data-f="period">${PLAN_PERIODS.map((x) => `<option value="${x}">${x || '—'}</option>`).join('')}</select>
        </label>
        <label><span class="setting-label">Devices</span><input data-f="devices" type="number" min="1" max="20" /></label>
        <label><span class="setting-label">Order</span><input data-f="order" type="number" min="0" max="99" /></label>
        <label class="plan-features"><span class="setting-label">What's included (one per line)</span>
          <textarea data-f="features" rows="3" placeholder="Unlimited downloads&#10;4K quality"></textarea>
        </label>
        <label><span class="setting-label">Buy link (optional)</span><input data-f="buyUrl" type="text" maxlength="300" placeholder="https://…" /></label>
        <div class="plan-flags">
          <label class="plan-check"><input data-f="active" type="checkbox" /> <span>Published</span></label>
          <label class="plan-check"><input data-f="highlight" type="checkbox" /> <span>Most popular</span></label>
          <button class="btn danger small" data-act="remove" type="button">Remove</button>
        </div>
      </div>`;
    const f = (name) => row.querySelector(`[data-f="${name}"]`);
    f('name').value = p.name || '';
    f('price').value = p.price || '';
    f('period').value = PLAN_PERIODS.includes(p.period) ? p.period : '';
    f('devices').value = Number(p.devices) || 1;
    f('order').value = Number.isFinite(Number(p.order)) ? Number(p.order) : i;
    f('features').value = (p.features || []).join('\n');
    f('buyUrl').value = p.buyUrl || '';
    f('active').checked = !!p.active;
    f('highlight').checked = !!p.highlight;
    row.querySelector('[data-act="remove"]').addEventListener('click', () => {
      plans.splice(i, 1);
      renderPlans();
    });
    box.appendChild(row);
  });
  const live = plans.filter((p) => p.active && String(p.price || '').trim()).length;
  const badge = $('plansState');
  badge.textContent = `${live} live in the app · ${plans.length} total`;
  badge.className = live ? 'hint ok' : 'hint warn';
}

// Read the form back out. Kept separate from renderPlans so typing never
// re-renders the row under the cursor.
function collectPlans() {
  return Array.from(document.querySelectorAll('.plan-row')).map((row, i) => {
    const f = (name) => row.querySelector(`[data-f="${name}"]`);
    const existing = plans[i] || {};
    return {
      id: existing.id || '',
      name: f('name').value.trim(),
      price: f('price').value.trim(),
      period: f('period').value,
      devices: Number(f('devices').value) || 1,
      order: Number(f('order').value) || i,
      features: f('features').value.split('\n').map((s) => s.trim()).filter(Boolean),
      buyUrl: f('buyUrl').value.trim(),
      active: f('active').checked,
      highlight: f('highlight').checked,
    };
  });
}

$('planAdd').addEventListener('click', () => {
  plans = collectPlans();
  plans.push({ id: '', name: '', price: '', period: 'per month', devices: 1, features: [], active: false, order: plans.length });
  renderPlans();
});

$('plansSave').addEventListener('click', async () => {
  const out = $('plansResult');
  out.textContent = 'Saving…';
  out.className = 'hint';
  const res = await api('/admin/api/plans', { method: 'POST', body: { plans: collectPlans() } });
  if (!res.ok) {
    out.textContent = res.error || 'Could not save.';
    out.className = 'hint warn';
    return;
  }
  plans = res.plans || [];
  renderPlans();
  out.textContent = 'Saved — live in the app within a few minutes.';
  out.className = 'hint ok';
});

// ---------- notifications ----------

const AUDIENCE_LABELS = {
  all: 'Everyone',
  trial: 'Trial users',
  'trial-exhausted': 'Trial ran out',
  paid: 'Paying customers',
  expired: 'Expired licences',
};

async function loadNotices() {
  const r = await api('/admin/api/notices');
  renderNotices(r.notices || []);
}

function renderNotices(list) {
  const box = $('noticesList');
  box.innerHTML = '';
  const live = list.filter((n) => n.active).length;
  const badge = $('noticesState');
  badge.textContent = list.length ? `${live} showing now · ${list.length} total` : 'Nothing published';
  badge.className = live ? 'hint ok' : 'hint';

  list.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'notice-row' + (n.active ? '' : ' off');
    const when = n.created_at ? new Date(n.created_at).toLocaleString() : '';
    row.innerHTML = `
      <div class="notice-main">
        <div class="notice-title"></div>
        <div class="notice-body"></div>
        <div class="notice-meta">
          <span class="badge ${n.level === 'warn' ? 'expired' : n.level === 'promo' ? 'active' : 'pending'}">${n.level}</span>
          <span class="audience"></span>
          <span class="when"></span>
        </div>
      </div>
      <div class="notice-actions">
        <button class="btn ghost small" data-act="toggle" type="button">${n.active ? 'Switch off' : 'Switch on'}</button>
        <button class="btn danger small" data-act="delete" type="button">Delete</button>
      </div>`;
    // Admin-typed text goes in as text, never as markup.
    row.querySelector('.notice-title').textContent = n.title || '';
    row.querySelector('.notice-body').textContent = n.body || '';
    row.querySelector('.audience').textContent = AUDIENCE_LABELS[n.audience] || n.audience;
    row.querySelector('.when').textContent = when;
    row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      const res = await api(`/admin/api/notices/${n.id}`, { method: 'PATCH', body: { active: !n.active } });
      renderNotices(res.notices || []);
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${n.title}"?`)) return;
      const res = await api(`/admin/api/notices/${n.id}`, { method: 'DELETE' });
      renderNotices(res.notices || []);
    });
    box.appendChild(row);
  });
}

$('noticePublish').addEventListener('click', async () => {
  const out = $('noticeResult');
  out.textContent = 'Publishing…';
  out.className = 'hint';
  const res = await api('/admin/api/notices', {
    method: 'POST',
    body: {
      title: $('ntTitle').value,
      body: $('ntBody').value,
      audience: $('ntAudience').value,
      level: $('ntLevel').value,
      actionLabel: $('ntActionLabel').value,
      actionUrl: $('ntActionUrl').value,
    },
  });
  if (!res.ok) {
    out.textContent = res.error || 'Could not publish.';
    out.className = 'hint warn';
    return;
  }
  $('ntTitle').value = '';
  $('ntBody').value = '';
  $('ntActionLabel').value = '';
  $('ntActionUrl').value = '';
  renderNotices(res.notices || []);
  out.textContent = 'Published — apps pick it up on their next heartbeat.';
  out.className = 'hint ok';
});

// ---------- free-trial settings ----------

function renderSettings(s) {
  $('setSignup').value = s.signupEnabled ? '1' : '0';
  $('setTrial').value = s.trialDownloads;
  $('setDays').value = s.defaultLicenseDays;
  $('setRate').value = s.signupPerHour;
  $('setDevices').value = s.defaultDeviceLimit;
  const badge = $('signupState');
  const rate = s.signupPerHour > 0 ? `${s.signupPerHour}/hour per IP` : 'no rate limit';
  badge.textContent = s.signupEnabled
    ? `Open — ${s.trialDownloads} free downloads per device · ${rate}`
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
      <td>${devicesCell(k)}</td>
      <td>${trialCell(k)}</td>
      <td>${fmtDate(k.created_at)}</td>
      <td>${fmtDate(k.last_heartbeat)}</td>
      <td>${statusBadge(k.status)}</td>
      <td class="actions">
        <button class="btn small ghost" data-act="copy">Copy</button>
        <button class="btn small ghost" data-act="edit">Edit</button>
        <button class="btn small ghost more-toggle" title="More actions">···</button>
        <span class="more-actions" hidden>
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
        </span>
      </td>
    `;
    tr.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => handleAction(b.dataset.act, k));
    });
    // The rare and destructive actions stay folded away, so the table fits on
    // screen instead of forcing a horizontal scroll past eight buttons.
    const moreBtn = tr.querySelector('.more-toggle');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const box = tr.querySelector('.more-actions');
        box.hidden = !box.hidden;
        moreBtn.classList.toggle('open', !box.hidden);
      });
    }
    tbody.appendChild(tr);
  }
}

// "2 / 3", and marked when the key is at its limit — that is the state that
// generates the support email, so it should be visible at a glance.
function devicesCell(k) {
  const used = k.devices_used || 0;
  const limit = k.devices_limit || 1;
  const full = used >= limit;
  const source = k.device_limit ? 'set on this key' : k.plan ? `from the ${escape(k.plan)} plan` : 'default';
  return `<span class="${full ? 'devices-full' : ''}" title="${source}">${used} / ${limit}</span>`;
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
  // Blank means "follow the plan", which is what most keys should do.
  $('editDevices').value = k.device_limit || '';
  const planPicker = $('editPlan');
  planPicker.innerHTML = '<option value="">No plan</option>'
    + plans.map((p) => `<option value="${escape(p.id)}">${escape(p.name)} (${p.devices || 1} device${(p.devices || 1) === 1 ? '' : 's'})</option>`).join('');
  planPicker.value = k.plan || '';
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
        signupPerHour: Number($('setRate').value),
        defaultDeviceLimit: Number($('setDevices').value),
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
    body: { email, note, expiresAt, plan: $('editPlan').value, deviceLimit: $('editDevices').value },
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
  // Two short lines instead of one long "7/12/2026, 4:56:52 PM" - the same
  // information in roughly half the column width.
  const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}<br><small class="muted">${time}</small>`;
}
function toDateInput(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Listeners first: loadAll() paints the cookie card, and a card you can see
// but not click is worse than one that is still loading.
wireCookies();
loadAll();
setInterval(loadAll, 30000);


// ---------- YouTube cookies ----------
//
// The jar is write-only from here. The panel can upload it, test it and delete
// it; it can never read it back, because what is stored is a live Google
// session and an admin screen is not a safe place to put one.

function cookieSummary(c) {
  if (!c || !c.present) {
    return { cls: 'none', head: 'No cookies uploaded — extraction runs anonymously.', rows: [] };
  }
  if (c.problems && c.problems.length) {
    return { cls: 'bad', head: c.problems[0], rows: cookieRows(c) };
  }
  const when = c.expiresAt ? new Date(c.expiresAt) : null;
  const days = when ? Math.round((when - Date.now()) / 86400000) : null;
  const head = days === null
    ? 'Cookies loaded.'
    : days <= 0
      ? 'Cookies have EXPIRED — upload a fresh export.'
      : `Cookies loaded — ${days} day${days === 1 ? '' : 's'} until the first one expires.`;
  return { cls: days !== null && days <= 0 ? 'bad' : 'good', head, rows: cookieRows(c) };
}

function cookieRows(c) {
  const rows = [
    ['Session cookies', c.sessionNames && c.sessionNames.length ? c.sessionNames.join(', ') : '(none)'],
    ['Google cookies', `${c.google || 0} of ${c.total || 0}`],
    ['In use by the extractor', c.active ? 'yes' : 'no'],
  ];
  if (c.expiresAt) rows.push(['First expiry', new Date(c.expiresAt).toLocaleString()]);
  if (c.uploadedAt) rows.push(['Uploaded', new Date(c.uploadedAt).toLocaleString()]);
  return rows;
}

function renderCookies(c) {
  const { cls, head, rows } = cookieSummary(c);
  const el = $('cookieState');
  el.className = `cookie-state ${cls}`;
  el.innerHTML = `<strong>${escape(head)}</strong>` + (rows.length
    ? `<dl>${rows.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(String(v))}</dd>`).join('')}</dl>`
    : '');
}

function cookieResult(text, cls = '') {
  const el = $('cookieResult');
  el.className = `cookie-result ${cls}`;
  el.textContent = text;
}

async function loadCookies() {
  const r = await api('/admin/api/cookies');
  renderCookies(r.cookies);
}

async function saveCookies() {
  const text = $('cookieText').value;
  if (!text.trim()) return cookieResult('Paste the file contents first.', 'bad');

  cookieResult('Saving…', 'busy');
  // Raw text, not JSON: a cookies.txt is neither, and wrapping it in JSON just
  // to unwrap it server-side would double the size for nothing.
  const res = await fetch('/admin/api/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    credentials: 'include',
    body: text,
  });
  if (res.status === 401) { location.href = '/login'; return; }
  const data = await res.json().catch(() => ({}));

  if (!data.ok) {
    cookieResult(data.error || 'Could not save those cookies.', 'bad');
    return;
  }
  // Clear the box on success so a live credential is not left sitting in a
  // textarea for the next person at this screen.
  $('cookieText').value = '';
  renderCookies(data.cookies);
  cookieResult('Saved. Test them to be sure they still work.', 'good');
}

async function testCookies() {
  cookieResult('Asking YouTube… this takes a few seconds.', 'busy');
  const r = await api('/admin/api/cookies/test', { method: 'POST', body: {} });
  const t = r.test || {};
  if (t.passed) {
    cookieResult(
      `Works — read "${t.title}" up to ${t.maxHeight || '?'}p in ${(t.tookMs / 1000).toFixed(1)}s.`,
      'good'
    );
    return;
  }
  cookieResult(
    t.blocked
      ? `Still blocked: ${t.error}  — the cookies are not signing the request in. Export again from a signed-in tab.`
      : `Failed: ${t.error || 'unknown error'}`,
    'bad'
  );
}

async function clearCookies() {
  if (!confirm('Remove the stored cookies? Extraction goes back to anonymous requests.')) return;
  const r = await api('/admin/api/cookies', { method: 'DELETE' });
  renderCookies(r.cookies);
  cookieResult('Removed.', '');
}

function wireCookies() {
  $('cookieSave').addEventListener('click', saveCookies);
  $('cookieTest').addEventListener('click', testCookies);
  $('cookieClear').addEventListener('click', clearCookies);
  $('cookiePick').addEventListener('click', () => $('cookieFile').click());
  $('cookieFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('cookieText').value = await f.text();
    cookieResult(`Loaded ${f.name} — press Save cookies.`, '');
    e.target.value = '';
  });
}
