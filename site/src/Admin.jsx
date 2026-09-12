import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const TOKEN_KEY = 'velox_admin_token';

/* Immutable deep set, so editing a nested field never mutates the loaded
   content in place - React needs a new object to notice the change. */
function setIn(obj, path, value) {
  if (!path.length) return value;
  const [head, ...rest] = path;
  const clone = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  clone[head] = setIn(clone[head], rest, value);
  return clone;
}
function getIn(obj, path) {
  return path.reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export default function Admin() {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  });
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!token) { setChecking(false); return; }
    api.adminCheck(token)
      .then((r) => { if (!r.valid) dropToken(); })
      .catch(() => dropToken())
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function keepToken(t) {
    setToken(t);
    try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ }
  }
  function dropToken() {
    setToken('');
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  }

  if (checking) return <div className="center-note">Checking your session…</div>;
  if (!token) return <Login onIn={keepToken} />;
  return <Editor token={token} onSignOut={() => { api.adminLogout(token).catch(() => {}); dropToken(); }} />;
}

/* ------------------------------------------------------------------ login */

/* The download counter shown on the home page.
   -------------------------------------------------------------------------
   It is a tally of clicks on the download button, and it needs correcting for
   ordinary reasons: clicks made while testing the site, a figure carried over
   from before the counter existed, or a restore that lost it. */
function DownloadCounter({ token }) {
  const [current, setCurrent] = React.useState(null);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState(null);

  const load = React.useCallback(() => {
    api.stats()
      .then((s) => {
        const n = Number(s && s.downloads) || 0;
        setCurrent(n);
        setValue(String(n));
      })
      .catch(() => setCurrent(null));
  }, []);

  React.useEffect(load, [load]);

  const save = async () => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) {
      setNote({ kind: 'bad', text: 'Enter a whole number, zero or more.' });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await api.adminSetDownloads(token, n);
      setCurrent(r.downloads);
      setNote({ kind: '', text: `Saved. The site now shows ${r.downloads.toLocaleString()} (was ${Number(r.previous).toLocaleString()}).` });
    } catch (e) {
      setNote({ kind: 'bad', text: e.message || 'Could not save.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-card">
      <h3>Download counter</h3>
      <p className="hint">
        The number under the hero. It counts clicks on the download button and
        rises on its own; set it here to correct test clicks or carry over a
        figure from before this counter existed.
      </p>
      <div className="row row-2">
        <div className="field-wrap">
          <label className="flabel">Live count</label>
          <div className="mono" style={{ fontSize: 22, padding: '6px 0' }}>
            {current === null ? '—' : current.toLocaleString()}
          </div>
        </div>
        <div className="field-wrap">
          <label className="flabel">Set it to</label>
          <input
            className="field mono"
            type="number"
            min="0"
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save count'}
        </button>
        <button className="mini" onClick={load} disabled={busy}>Refresh</button>
      </div>
      {note && <div className={`notice ${note.kind}`} style={{ marginTop: 12 }}>{note.text}</div>}
    </div>
  );
}

function Login({ onIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.adminLogin(password);
      onIn(r.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-login" onSubmit={submit}>
      <div>
        <div className="eyebrow">Velox</div>
        <h2 style={{ fontSize: 24, marginTop: 8 }}>Site editor</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 14, marginTop: 8 }}>
          Everything the public page says is edited here.
        </p>
      </div>
      <div>
        <label className="flabel" htmlFor="pw">Admin password</label>
        <input
          id="pw" className="field" type="password" autoFocus autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && <div className="notice bad">{error}</div>}
      <button className="btn btn-primary" disabled={busy || !password}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
    </form>
  );
}

/* ----------------------------------------------------------------- fields */

function Text({ c, set, path, label, area }) {
  const value = getIn(c, path) ?? '';
  const Tag = area ? 'textarea' : 'input';
  return (
    <div>
      <label className="flabel">{label}</label>
      <Tag className="field" value={value} onChange={(e) => set(path, e.target.value)} />
    </div>
  );
}

/* Add / remove / edit a list of objects, used for every repeatable block. */
function List({ c, set, path, label, hint, fields, blank, tag }) {
  const items = getIn(c, path) || [];
  const update = (i, key, v) => set([...path, i, key], v);
  const add = () => set(path, [...items, { ...blank }]);
  const remove = (i) => set(path, items.filter((_, n) => n !== i));
  const move = (i, dir) => {
    const next = [...items];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set(path, next);
  };

  return (
    <div className="admin-card">
      <h3>{label}</h3>
      {hint && <p className="hint">{hint}</p>}
      {items.map((item, i) => (
        <div className="item-edit" key={i}>
          <div className="item-top">
            <span className="item-tag">{tag ? tag(item, i) : `#${i + 1}`}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="mini" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className="mini" onClick={() => move(i, 1)} disabled={i === items.length - 1}>↓</button>
              <button type="button" className="mini danger" onClick={() => remove(i)}>Remove</button>
            </span>
          </div>
          {fields.map((f) => (
            <div key={f.key} style={{ marginBottom: 9 }}>
              <label className="flabel">{f.label}</label>
              {f.area ? (
                <textarea className="field" value={item[f.key] ?? ''} onChange={(e) => update(i, f.key, e.target.value)} />
              ) : (
                <input className="field" value={item[f.key] ?? ''} onChange={(e) => update(i, f.key, e.target.value)} />
              )}
            </div>
          ))}
        </div>
      ))}
      <button type="button" className="mini" onClick={add}>+ Add</button>
    </div>
  );
}

/* A plain list of strings (platforms, browsers, badges, specs). */
function Chips({ c, set, path, label, hint }) {
  const items = getIn(c, path) || [];
  return (
    <div>
      <label className="flabel">{label}</label>
      {hint && <p className="hint" style={{ marginBottom: 8 }}>{hint}</p>}
      <textarea
        className="field"
        value={items.join('\n')}
        onChange={(e) => set(path, e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- editor */

function Editor({ token, onSignOut }) {
  const [c, setC] = useState(null);
  const [orders, setOrders] = useState([]);
  const [downloads, setDownloads] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('');

  useEffect(() => {
    api.content().then((r) => setC(r.content)).catch((e) => setMsg({ kind: 'bad', text: e.message }));
    api.adminOrders(token)
      .then((r) => { setOrders(r.orders || []); setDownloads(r.downloads || 0); })
      .catch(() => {});
  }, [token]);

  const set = (path, value) => {
    setC((prev) => setIn(prev, path, value));
    setDirty(true);
    setMsg(null);
  };

  async function save(next) {
    setBusy(true);
    setMsg(null);
    try {
      const payload = next || c;
      await api.adminSave(token, payload);
      setC(payload);
      setDirty(false);
      setMsg({ kind: 'good', text: 'Saved. The public site shows this now.' });
    } catch (e) {
      setMsg({ kind: 'bad', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  function applyRaw() {
    try {
      const parsed = JSON.parse(rawText);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Top level must be an object');
      setC(parsed);
      setDirty(true);
      setRaw(false);
      setMsg({ kind: 'good', text: 'JSON applied — press Save to publish it.' });
    } catch (e) {
      setMsg({ kind: 'bad', text: `That JSON is not valid: ${e.message}` });
    }
  }

  if (!c) return <div className="center-note">Loading content…</div>;

  return (
    <div className="admin-shell">
      <div className="wrap">
        <div className="admin-head">
          <div>
            <div className="eyebrow">Velox site editor</div>
            <h2 style={{ fontSize: 26, marginTop: 6 }}>Edit the public page</h2>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="os-badge">{downloads.toLocaleString()} downloads</span>
            <a className="mini" href="/" target="_blank" rel="noreferrer">View site ↗</a>
            <button className="mini" onClick={() => { setRawText(JSON.stringify(c, null, 2)); setRaw(!raw); }}>
              {raw ? 'Back to form' : 'Edit raw JSON'}
            </button>
            <button className="mini danger" onClick={onSignOut}>Sign out</button>
          </div>
        </div>

        {msg && <div className={`notice ${msg.kind}`} style={{ marginBottom: 18 }}>{msg.text}</div>}

        {raw ? (
          <div className="admin-card">
            <h3>Raw content JSON</h3>
            <p className="hint">The whole document. Useful for bulk edits or anything the form above does not cover.</p>
            <textarea className="field" style={{ minHeight: 460, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              value={rawText} onChange={(e) => setRawText(e.target.value)} />
            <button className="mini" style={{ marginTop: 12 }} onClick={applyRaw}>Apply JSON</button>
          </div>
        ) : (
          <>
            <DownloadCounter token={token} />

            <div className="admin-card">
              <h3>Brand and navigation</h3>
              <p className="hint">The sticky header: name, version badge, and the links across the middle.</p>
              <div className="row row-2">
                <Text c={c} set={set} path={['brand', 'name']} label="Product name" />
                <Text c={c} set={set} path={['brand', 'tagline']} label="Tagline (under the name)" />
              </div>
              <div className="row row-3">
                <Text c={c} set={set} path={['brand', 'version']} label="Version" />
                <Text c={c} set={set} path={['brand', 'osBadge']} label="OS badge" />
                <Text c={c} set={set} path={['nav', 'cta']} label="Header button" />
              </div>
            </div>

            <List c={c} set={set} path={['nav', 'links']} label="Header links"
              hint="Order here is the order on the page. href can be an anchor like #pricing."
              fields={[{ key: 'label', label: 'Label' }, { key: 'href', label: 'Link' }]}
              blank={{ label: '', href: '#' }} tag={(i) => i.label || 'link'} />

            <div className="admin-card">
              <h3>Hero</h3>
              <p className="hint">The first screen. The accent half of the headline is shown in the blue gradient.</p>
              <div className="row row-2">
                <Text c={c} set={set} path={['hero', 'headline']} label="Headline" />
                <Text c={c} set={set} path={['hero', 'headlineAccent']} label="Headline (gradient half)" />
              </div>
              <div className="row"><Text c={c} set={set} path={['hero', 'sub']} label="Sub-headline" area /></div>
              <div className="row row-2">
                <Text c={c} set={set} path={['hero', 'primaryCta']} label="Main button" />
                <Text c={c} set={set} path={['hero', 'downloadUrl']} label="Download file URL" />
              </div>
              <div className="row row-2">
                <Text c={c} set={set} path={['hero', 'secondaryCta']} label="Secondary link" />
                <Text c={c} set={set} path={['hero', 'secondaryUrl']} label="Secondary link URL" />
              </div>
              <div className="row"><Text c={c} set={set} path={['hero', 'micro']} label="Micro-copy under the buttons" /></div>
            </div>

            <div className="admin-card">
              <h3>Supported ecosystems</h3>
              <p className="hint">One name per line. Platforms show first, then browsers after the divider.</p>
              <div className="row"><Text c={c} set={set} path={['ecosystems', 'label']} label="Strip heading" /></div>
              <div className="row row-2">
                <Chips c={c} set={set} path={['ecosystems', 'platforms']} label="Platforms" />
                <Chips c={c} set={set} path={['ecosystems', 'browsers']} label="Browsers" />
              </div>
            </div>

            <div className="admin-card">
              <h3>Injection engine section</h3>
              <div className="row row-2">
                <Text c={c} set={set} path={['injection', 'eyebrow']} label="Eyebrow" />
                <Text c={c} set={set} path={['injection', 'title']} label="Title" />
              </div>
              <div className="row"><Text c={c} set={set} path={['injection', 'sub']} label="Intro" area /></div>
              <div className="row"><Chips c={c} set={set} path={['injection', 'specs']} label="Technical specs (one per line)" /></div>
            </div>

            <List c={c} set={set} path={['injection', 'steps']} label="Injection steps"
              fields={[{ key: 'title', label: 'Title' }, { key: 'body', label: 'Description', area: true }]}
              blank={{ title: '', body: '' }} tag={(i) => i.title || 'step'} />

            <List c={c} set={set} path={['capabilities']} label="Core capability cards"
              hint="The glass card grid. The icon is a short label shown in the tile - 01, 4K, and so on."
              fields={[{ key: 'icon', label: 'Icon label' }, { key: 'title', label: 'Title' }, { key: 'body', label: 'Description', area: true }]}
              blank={{ icon: '', title: '', body: '' }} tag={(i) => i.title || 'card'} />

            <div className="admin-card">
              <h3>How it works</h3>
              <div className="row"><Text c={c} set={set} path={['howItWorks', 'heading']} label="Heading" /></div>
            </div>

            <List c={c} set={set} path={['howItWorks', 'steps']} label="Workflow steps"
              fields={[{ key: 'n', label: 'Number' }, { key: 'title', label: 'Title' }, { key: 'body', label: 'Description', area: true }]}
              blank={{ n: '', title: '', body: '' }} tag={(i) => i.title || 'step'} />

            <div className="admin-card">
              <h3>Pricing</h3>
              <p className="hint">
                The price here is what PayPal charges. Use plain numbers such as 19.99, and a three-letter
                currency such as USD.
              </p>
              <div className="row row-2">
                <Text c={c} set={set} path={['pricing', 'heading']} label="Heading" />
                <Text c={c} set={set} path={['pricing', 'sub']} label="Sub-heading" />
              </div>
              <div className="row row-3">
                <Text c={c} set={set} path={['pricing', 'price']} label="Price" />
                <Text c={c} set={set} path={['pricing', 'currency']} label="Currency" />
                <Text c={c} set={set} path={['pricing', 'period']} label="Period" />
              </div>
              <div className="row row-3">
                <Text c={c} set={set} path={['pricing', 'product']} label="What PayPal calls it" />
                <Text c={c} set={set} path={['pricing', 'freeLabel']} label="Free column" />
                <Text c={c} set={set} path={['pricing', 'proLabel']} label="Pro column" />
              </div>
            </div>

            <List c={c} set={set} path={['pricing', 'rows']} label="Comparison table rows"
              fields={[{ key: 'feature', label: 'Feature' }, { key: 'free', label: 'Free' }, { key: 'pro', label: 'Pro' }]}
              blank={{ feature: '', free: '', pro: '' }} tag={(i) => i.feature || 'row'} />

            <div className="admin-card">
              <h3>Trust badges</h3>
              <div className="row"><Text c={c} set={set} path={['trust', 'heading']} label="Heading" /></div>
              <div className="row"><Chips c={c} set={set} path={['trust', 'badges']} label="Badges (one per line)" /></div>
            </div>

            <div className="admin-card">
              <h3>Help Center</h3>
              <p className="hint">
                What the app's Get help button opens. Each guide shows a picture or a
                YouTube video — fill in whichever you have; the video brings its own
                thumbnail, so a guide with a video needs no image at all.
              </p>
              <div className="row">
                <Text c={c} set={set} path={['help', 'heading']} label="Heading" />
                <Text c={c} set={set} path={['help', 'sub']} label="Sub-heading" />
              </div>
            </div>

            <List c={c} set={set} path={['help', 'articles']} label="Help articles"
              hint="Paste any YouTube link — a watch URL, a share link, an embed or a short all work."
              tag={(item) => item.title || 'Untitled'}
              blank={{ title: '', description: '', image: '', video: '' }}
              fields={[
                { key: 'title', label: 'Title' },
                { key: 'description', label: 'Description', area: true },
                { key: 'video', label: 'YouTube link (optional)' },
                { key: 'image', label: 'Image URL (used when there is no video)' },
              ]} />

            <List c={c} set={set} path={['faq']} label="FAQ"
              fields={[{ key: 'q', label: 'Question' }, { key: 'a', label: 'Answer', area: true }]}
              blank={{ q: '', a: '' }} tag={(i) => i.q || 'question'} />

            <List c={c} set={set} path={['footer', 'links']} label="Footer links"
              fields={[{ key: 'label', label: 'Label' }, { key: 'href', label: 'Link' }]}
              blank={{ label: '', href: '#' }} tag={(i) => i.label || 'link'} />

            <div className="admin-card">
              <h3>Footer legal</h3>
              <div className="row"><Text c={c} set={set} path={['footer', 'disclaimer']} label="Terms / fair use disclaimer" area /></div>
              <div className="row"><Text c={c} set={set} path={['footer', 'copyright']} label="Company name" /></div>
            </div>

            <Orders orders={orders} />
          </>
        )}

        <div className="sticky-save">
          <span style={{ color: dirty ? 'var(--warning)' : 'var(--text-faint)', fontSize: 13.5 }}>
            {dirty ? 'You have unsaved changes' : 'Everything is saved'}
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => save()} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save and publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Orders({ orders }) {
  return (
    <div className="admin-card">
      <h3>Orders</h3>
      <p className="hint">
        Every PayPal order. Anything marked <b>paid-key-failed</b> took the customer's money without
        issuing a key — create one in the licence admin panel and send it.
      </p>
      {orders.length === 0 ? (
        <p style={{ color: 'var(--text-faint)', fontSize: 14 }}>No orders yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="orders">
            <thead>
              <tr><th>When</th><th>Email</th><th>Status</th><th>Amount</th><th>Key</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.createdAt ? new Date(o.createdAt).toLocaleString() : '—'}</td>
                  <td>{o.email}</td>
                  <td>
                    <span className={`pill ${o.status === 'completed' ? 'completed' : o.status === 'created' ? 'created' : 'failed'}`}>
                      {o.status}
                    </span>
                  </td>
                  <td>{o.amount || '—'}</td>
                  <td className="mono">{o.key || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
