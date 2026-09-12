// Account tab + the banner strip for messages we broadcast from the admin panel.
//
// Everything shown here arrives on the licence heartbeat, which already runs on
// a timer, so a price or a message changed on the server appears in a running
// app on its own — the customer never restarts anything and never presses
// anything to "check for" it.
(() => {
  if (!window.api || !window.api.accountInfo) return;

  const $ = (id) => document.getElementById(id);
  let current = { profile: null, plans: [], notices: [], storeUrl: '', helpUrl: '' };

  // Falls back to the store's own help anchor, so the button still goes
  // somewhere useful before the first heartbeat has answered.
  const helpUrl = () =>
    current.helpUrl || (current.storeUrl ? current.storeUrl.replace(/\/+$/, '') + '/#help' : '');

  // ---- small helpers -------------------------------------------------------

  function fmtDate(ms) {
    if (!ms) return 'Never expires';
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '—';
    }
  }

  function daysLeftText(profile) {
    if (!profile || !profile.expiresAt) return '';
    const days = Math.max(0, Math.ceil((profile.expiresAt - Date.now()) / 86400000));
    if (days === 0) return 'expires today';
    return `${days} day${days === 1 ? '' : 's'} left`;
  }

  function statusLabel(profile) {
    if (!profile) return { text: 'Not signed in', cls: 'off' };
    if (profile.status === 'expired') return { text: 'Expired', cls: 'warn' };
    if (profile.status === 'blocked' || profile.status === 'revoked') return { text: 'Suspended', cls: 'bad' };
    if (profile.trial) return { text: 'Free trial', cls: 'trial' };
    return { text: 'Active', cls: 'ok' };
  }

  // ---- the banner strip ----------------------------------------------------

  // The same messages, in the compact form the lock screen has room for. No
  // dismiss button there: the screen goes away as soon as the licence is fixed.
  function renderLockNotices(notices) {
    const box = $('lockNotices');
    if (!box) return;
    box.innerHTML = '';
    for (const n of notices || []) {
      const row = document.createElement('div');
      row.className = `lock-notice level-${n.level || 'info'}`;
      const title = document.createElement('strong');
      title.textContent = n.title || '';
      const body = document.createElement('span');
      body.textContent = n.body || '';
      row.append(title, body);
      if (n.actionUrl && n.actionLabel) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'primary-btn sm';
        btn.textContent = n.actionLabel;
        btn.addEventListener('click', () => window.api.openStore(n.actionUrl));
        row.appendChild(btn);
      }
      box.appendChild(row);
    }
  }

  function renderNotices(notices) {
    renderLockNotices(notices);
    const bar = $('noticeBar');
    if (!bar) return;
    bar.innerHTML = '';
    for (const n of notices || []) {
      const row = document.createElement('div');
      row.className = `notice-banner level-${n.level || 'info'}`;
      row.innerHTML = `
        <div class="notice-text">
          <strong class="notice-b-title"></strong>
          <span class="notice-b-body"></span>
        </div>
        <div class="notice-b-actions">
          <button type="button" class="primary-btn sm notice-b-action" hidden></button>
          <button type="button" class="icon-btn sm notice-b-close" aria-label="Dismiss">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>`;
      // Server-supplied text goes in as text, never markup.
      row.querySelector('.notice-b-title').textContent = n.title || '';
      row.querySelector('.notice-b-body').textContent = n.body || '';

      const action = row.querySelector('.notice-b-action');
      if (n.actionUrl && n.actionLabel) {
        action.textContent = n.actionLabel;
        action.hidden = false;
        action.addEventListener('click', () => window.api.openStore(n.actionUrl));
      }
      row.querySelector('.notice-b-close').addEventListener('click', async () => {
        row.remove();
        const res = await window.api.noticeDismiss(n.id);
        // A fresh object: `current` is what the main process handed over, and
        // writing back into it would edit the caller's copy too.
        if (res && res.notices) current = { ...current, notices: res.notices };
      });
      bar.appendChild(row);
    }
  }

  // ---- the Account tab -----------------------------------------------------

  function renderAccount(info) {
    const profile = info.profile || null;
    const plan = (profile && profile.plan) || null;

    const badge = $('acctStatus');
    const status = statusLabel(profile);
    badge.textContent = status.text;
    badge.className = `acct-badge ${status.cls}`;

    const email = (profile && profile.email) || '';
    $('acctEmail').textContent = email || 'Not signed in';
    $('acctAvatar').textContent = (email[0] || 'U').toUpperCase();
    $('acctKey').textContent = (profile && profile.key) || '';

    $('acctPlan').textContent = plan ? plan.name : '—';
    const validity = profile ? fmtDate(profile.expiresAt) : '—';
    const left = daysLeftText(profile);
    $('acctValid').textContent = validity;
    $('acctValidSub').textContent = left;

    const today = profile && Number.isFinite(profile.downloadsToday) ? profile.downloadsToday : 0;
    $('acctToday').textContent = String(today);

    // How many machines this licence is on, and how many it may be on. Being at
    // the limit is the thing worth saying plainly, because that is what stops a
    // new PC activating.
    const devices = (profile && profile.devices) || null;
    if (devices) {
      $('acctDevices').textContent = `${devices.used} of ${devices.limit}`;
      $('acctDevicesSub').textContent = devices.used >= devices.limit
        ? 'All in use — remove one to add another'
        : `${devices.limit - devices.used} free`;
    } else {
      $('acctDevices').textContent = '—';
      $('acctDevicesSub').textContent = '';
    }

    // Only a trial has a number of downloads left to show.
    const trialStat = $('acctTrialStat');
    if (profile && profile.trial && Number.isFinite(profile.trialRemaining)) {
      trialStat.hidden = false;
      $('acctTrial').textContent = `${profile.trialRemaining} of ${profile.trialTotal}`;
    } else {
      trialStat.hidden = true;
    }

    // What the subscription includes, straight from the plan the key sits on.
    const features = (plan && plan.features) || [];
    const includedBox = $('acctIncluded');
    const list = $('acctFeatures');
    list.innerHTML = '';
    includedBox.hidden = features.length === 0;
    for (const f of features) {
      const li = document.createElement('li');
      li.textContent = f;
      list.appendChild(li);
    }

    renderPlans(info);
  }

  function renderPlans(info) {
    const box = $('acctPlans');
    const plans = info.plans || [];
    const currentPlanId = info.profile && info.profile.plan ? info.profile.plan.id : null;
    box.innerHTML = '';

    if (!plans.length) {
      box.innerHTML = '<div class="acct-empty">Pricing is not available right now.</div>';
      return;
    }

    for (const p of plans) {
      const card = document.createElement('div');
      const isCurrent = currentPlanId && p.id === currentPlanId;
      card.className = 'plan-card' + (p.highlight ? ' highlight' : '') + (isCurrent ? ' current' : '');
      card.innerHTML = `
        <div class="plan-flag" hidden>Most popular</div>
        <div class="plan-name"></div>
        <div class="plan-price"><span class="plan-amount"></span> <span class="plan-period"></span></div>
        <div class="plan-devices"></div>
        <ul class="plan-features"></ul>
        <button type="button" class="primary-btn plan-buy"></button>`;
      card.querySelector('.plan-name').textContent = p.name || '';
      card.querySelector('.plan-amount').textContent = p.price || '';
      card.querySelector('.plan-period').textContent = p.period || '';
      const devices = Number(p.devices) || 1;
      card.querySelector('.plan-devices').textContent = `${devices} device${devices === 1 ? '' : 's'}`;
      if (p.highlight) card.querySelector('.plan-flag').hidden = false;

      const ul = card.querySelector('.plan-features');
      for (const f of p.features || []) {
        const li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      }

      const buy = card.querySelector('.plan-buy');
      if (isCurrent) {
        buy.textContent = 'Your plan';
        buy.disabled = true;
      } else {
        buy.textContent = 'Upgrade';
        buy.addEventListener('click', () => window.api.openStore(p.buyUrl || info.storeUrl));
      }
      box.appendChild(card);
    }
  }

  function render(info) {
    if (!info) return;
    current = info;
    renderNotices(info.notices);
    if ($('acctEmail')) renderAccount(info);
  }

  // ---- wiring --------------------------------------------------------------

  window.api.accountInfo().then(render).catch(() => {});

  // A heartbeat brought something new: a price change, a message, a fresh count.
  window.api.onAccountUpdated(render);

  // Opening the tab asks the server straight away, so the numbers on screen are
  // today's rather than whatever the last beat happened to carry.
  const tabBtn = document.querySelector('.side-btn[data-tab="account"]');
  if (tabBtn) {
    tabBtn.addEventListener('click', () => {
      window.api.accountRefresh().then(render).catch(() => {});
    });
  }

  const refreshBtn = $('accountRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Checking…';
      try {
        render(await window.api.accountRefresh());
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
      }
    });
  }

  const upgradeBtn = $('acctUpgrade');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', () => window.api.openStore(current.storeUrl));
  }

  // On the lock screen there is no Account tab to reach, so pricing gets its
  // own way out — this is what a customer whose trial ended could not find.
  const lockStoreBtn = $('lkStoreBtn');
  if (lockStoreBtn) {
    lockStoreBtn.addEventListener('click', () => window.api.openStore(current.storeUrl));
  }

  // Get help, from the two places someone needs it: locked out at the door,
  // and mid-download inside the app.
  for (const id of ['lkHelpBtn', 'helpBtn']) {
    const btn = $(id);
    if (btn) btn.addEventListener('click', () => {
      const url = helpUrl();
      if (url) window.api.openStore(url);
    });
  }
})();
