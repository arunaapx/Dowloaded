import React, { useEffect, useRef, useState } from 'react';
import { api, loadPayPal, detectOS } from './api.js';

/* ------------------------------------------------------------------ icons */

const LogoMark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const Play = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="8,5 19,12 8,19" /></svg>
);
const DownIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
  </svg>
);

/* ------------------------------------------------------------------ page */

export default function App() {
  const [content, setContent] = useState(null);
  const [stats, setStats] = useState(null);
  const [failed, setFailed] = useState(false);
  const os = detectOS();

  useEffect(() => {
    Promise.all([api.content(), api.stats()])
      .then(([c, s]) => {
        setContent(c.content);
        setStats(s);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="center-note">
        <p>The site could not load its content.</p>
        <p style={{ fontSize: 13, marginTop: 8 }}>Check that the store API is running on port 8090.</p>
      </div>
    );
  }
  if (!content) return <div className="center-note">Loading…</div>;

  const c = content;

  return (
    <>
      <Nav c={c} os={os} />
      <main>
        <Hero c={c} os={os} stats={stats} setStats={setStats} />
        <Ecosystems c={c} />
        <Injection c={c} />
        <Capabilities c={c} />
        <HowItWorks c={c} />
        <Pricing c={c} stats={stats} />
        <Trust c={c} />
        <Faq c={c} />
      </main>
      <Footer c={c} />
    </>
  );
}

/* ------------------------------------------------------- 1. sticky glass nav */

function Nav({ c, os }) {
  const brand = c.brand || {};
  const nav = c.nav || {};
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <a className="logo" href="#top">
          <span className="logo-mark"><LogoMark /></span>
          <span>
            <div className="logo-name">{brand.name || 'Velox Downloader'}</div>
            <div className="logo-sub">{brand.tagline}</div>
          </span>
        </a>

        <nav className="nav-links">
          {(nav.links || []).map((l, i) => (
            <a key={i} href={l.href}>{l.label}</a>
          ))}
        </nav>

        <div className="nav-right">
          <span className="os-badge">{brand.osBadge || `v${brand.version || '2.4'} for ${os}`}</span>
          <a className="btn btn-glass btn-sm" href="#pricing">{nav.cta || 'Download Free'}</a>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ 2. hero */

function Hero({ c, os, stats, setStats }) {
  const h = c.hero || {};

  // The counter is the honest number of clicks on this button, so it is bumped
  // here rather than being decorative.
  const onDownload = async () => {
    try {
      const r = await api.countDownload();
      setStats((s) => ({ ...(s || {}), downloads: r.downloads }));
    } catch {
      /* a counter failure must never block the download itself */
    }
  };

  return (
    <section className="hero" id="top">
      <div className="wrap hero-grid">
        <div>
          <h1>
            {h.headline} <span className="grad">{h.headlineAccent}</span>
          </h1>
          <p className="hero-sub">{h.sub}</p>

          <div className="hero-cta">
            <a className="btn btn-primary" href={h.downloadUrl || '#'} onClick={onDownload}>
              <DownIcon />
              {(h.primaryCta || 'Download').replace('Windows', os)}
            </a>
            <a className="btn btn-glass" href={h.secondaryUrl || '#extension'}>
              {h.secondaryCta}
            </a>
          </div>

          {stats && (
            <div className="dl-count" title="Downloads so far">
              <span className="dl-dot" />
              <b>{Number(stats.downloads || 0).toLocaleString()}</b> downloads
            </div>
          )}

          <p className="hero-micro">{h.micro}</p>
        </div>

        <GlassMockup />
      </div>
    </section>
  );
}

/* Layered glass: the browser with its floating grab pin in front, the desktop
   app's download queue blurred behind it - the two halves of the product. */
function GlassMockup() {
  return (
    <div className="stage">
      <div className="layer-back" aria-hidden="true">
        <div className="queue-head">Velox — download queue</div>
        {[78, 46, 22].map((p, i) => (
          <div className="queue-row" key={i}>
            <div className="queue-thumb" />
            <div className="queue-lines">
              <div className="queue-line" />
              <div className="queue-line short" />
              <div className="queue-track"><div className="queue-fill" style={{ width: `${p}%` }} /></div>
            </div>
          </div>
        ))}
      </div>

      <div className="layer-front">
        <div className="chrome-bar">
          <span className="chrome-dot" /><span className="chrome-dot" /><span className="chrome-dot" />
          <span className="chrome-url">https://www.youtube.com/watch?v=…</span>
        </div>
        <div className="player">
          <div className="player-play"><Play /></div>
          <div className="grab-pin"><DownIcon /> Download</div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- 3. ecosystems bar */

function Ecosystems({ c }) {
  const e = c.ecosystems || {};
  return (
    <section className="wrap" style={{ paddingBottom: 8 }}>
      <div className="eco">
        <div className="eco-label">{e.label}</div>
        {(e.platforms || []).map((p) => <span className="eco-chip" key={p}>{p}</span>)}
        <span className="eco-sep" />
        {(e.browsers || []).map((b) => <span className="eco-chip" key={b}>{b}</span>)}
      </div>
    </section>
  );
}

/* ------------------------------------------------- 4. the injection engine */

function Injection({ c }) {
  const j = c.injection || {};
  return (
    <section className="section" id="extension">
      <div className="wrap inj-grid">
        <div>
          <div className="eyebrow">{j.eyebrow}</div>
          <h2 style={{ fontSize: 'clamp(27px,3.3vw,38px)', margin: '12px 0 14px' }}>{j.title}</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: '16.5px' }}>{j.sub}</p>
          <div className="spec-list">
            {(j.specs || []).map((s) => <span className="spec" key={s}>{s}</span>)}
          </div>
        </div>

        <div className="inj-steps">
          {(j.steps || []).map((s, i) => (
            <div className="inj-step" key={i}>
              <span className="inj-num">{i + 1}</span>
              <div>
                <h4>{s.title}</h4>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- 5. capabilities */

function Capabilities({ c }) {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <div className="section-head">
          <div className="eyebrow">Core capabilities</div>
          <h2>Built for the videos that usually fight back.</h2>
          <p>Adaptive streams, split audio, throttled CDNs, dead connections — the parts that break other downloaders are the parts Velox is designed around.</p>
        </div>
        <div className="caps">
          {(c.capabilities || []).map((cap, i) => (
            <article className="cap" key={i}>
              <div className="cap-icon">{cap.icon || String(i + 1).padStart(2, '0')}</div>
              <h3>{cap.title}</h3>
              <p>{cap.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- 6. how it works */

function HowItWorks({ c }) {
  const h = c.howItWorks || {};
  return (
    <section className="section" id="how">
      <div className="wrap">
        <div className="section-head center">
          <div className="eyebrow">How it works</div>
          <h2>{h.heading}</h2>
        </div>
        <div className="steps">
          {(h.steps || []).map((s, i) => (
            <article className="step" key={i}>
              <div className="step-n">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------- 7. pricing + comparison + buy */

function Pricing({ c, stats }) {
  const p = c.pricing || {};
  return (
    <section className="section" id="pricing">
      <div className="wrap">
        <div className="section-head">
          <div className="eyebrow">Pricing</div>
          <h2>{p.heading}</h2>
          <p>{p.sub}</p>
        </div>

        <div className="pricing-wrap">
          <div className="compare">
            <div className="compare-scroll">
              <table className="cmp">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>{p.freeLabel || 'Free Version'}</th>
                    <th className="pro">
                      {p.proLabel || 'Pro License'} (${p.price}/{(p.period || 'per year').replace('per ', '')})
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(p.rows || []).map((r, i) => (
                    <tr key={i}>
                      <td>{r.feature}</td>
                      <td>{r.free}</td>
                      <td className="pro">{r.pro}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <BuyCard p={p} stats={stats} />
        </div>
      </div>
    </section>
  );
}

function BuyCard({ p, stats }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState(null);
  const [licenceKey, setLicenceKey] = useState(null);
  const slot = useRef(null);
  const rendered = useRef(false);
  const emailRef = useRef('');
  emailRef.current = email;

  const ready = stats && stats.checkoutReady && stats.paypalClientId;

  useEffect(() => {
    if (!ready || rendered.current || !slot.current) return;
    rendered.current = true;

    loadPayPal(stats.paypalClientId, stats.currency)
      .then((paypal) => {
        paypal
          .Buttons({
            style: { shape: 'pill', color: 'blue', layout: 'vertical', label: 'paypal', height: 46 },
            // Validate before PayPal opens: the key is emailed to this address,
            // so an empty box would mean a paid order we cannot deliver.
            onClick: (_d, actions) => {
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRef.current)) {
                setMsg({ kind: 'bad', text: 'Enter your email first — your licence key is sent there.' });
                return actions.reject();
              }
              setMsg(null);
              return actions.resolve();
            },
            createOrder: async () => {
              const r = await api.createOrder(emailRef.current);
              return r.id;
            },
            onApprove: async (data) => {
              try {
                const r = await api.captureOrder(data.orderID);
                setLicenceKey(r.key);
                setMsg({ kind: 'good', text: 'Payment complete. Your licence key is below — it has also been recorded against your email.' });
              } catch (e) {
                setMsg({ kind: 'bad', text: e.message });
              }
            },
            onError: () => setMsg({ kind: 'bad', text: 'PayPal could not complete the payment. Nothing was charged.' }),
          })
          .render(slot.current);
      })
      .catch(() => setMsg({ kind: 'bad', text: 'Could not load PayPal. Check your connection and refresh.' }));
  }, [ready, stats]);

  return (
    <aside className="buy-card">
      <div className="price-tag">
        <span className="price-amount">${p.price}</span>
        <span className="price-per">{p.period || 'per year'}</span>
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 14.4 }}>{p.product}</p>

      {licenceKey ? (
        <>
          <div className="keybox">{licenceKey}</div>
          <p style={{ color: 'var(--text-dim)', fontSize: 13.4 }}>
            Open Velox, choose <b>I have a key</b> and paste this in to activate.
          </p>
        </>
      ) : (
        <>
          <div>
            <label className="flabel" htmlFor="buyer-email">Email for your licence key</label>
            <input
              id="buyer-email"
              className="field"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {ready ? (
            <div className="paypal-slot" ref={slot} />
          ) : (
            <div className="notice warn">
              Checkout is not switched on yet. Add your PayPal Client ID and Secret to the
              store service and this becomes a live PayPal button.
            </div>
          )}
        </>
      )}

      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}

      {stats && stats.mode === 'sandbox' && ready && (
        <div className="notice warn">Sandbox mode — test payments only, no real money moves.</div>
      )}
    </aside>
  );
}

/* -------------------------------------------------------------- 8. trust */

function Trust({ c }) {
  const t = c.trust || {};
  return (
    <section className="section" style={{ paddingBottom: 0 }}>
      <div className="wrap">
        <div className="section-head center">
          <div className="eyebrow">Safety and trust</div>
          <h2>{t.heading}</h2>
        </div>
        <div className="badges">
          {(t.badges || []).map((b) => (
            <div className="badge-item" key={b}>
              <span className="badge-check"><Check /></span>
              {b}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq({ c }) {
  const [open, setOpen] = useState(0);
  const items = c.faq || [];
  return (
    <section className="section" id="faq">
      <div className="wrap">
        <div className="section-head center">
          <div className="eyebrow">FAQ</div>
          <h2>Questions people actually ask</h2>
        </div>
        <div className="faq">
          {items.map((f, i) => {
            const isOpen = open === i;
            return (
              <div className={`faq-item${isOpen ? ' open' : ''}`} key={i}>
                <button
                  className="faq-q"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? -1 : i)}
                >
                  {f.q}
                  <span className="faq-sign" aria-hidden="true">+</span>
                </button>
                {isOpen && <div className="faq-a">{f.a}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- 9. footer */

function Footer({ c }) {
  const f = c.footer || {};
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-top">
          <div className="logo">
            <span className="logo-mark"><LogoMark /></span>
            <span>
              <div className="logo-name">{(c.brand || {}).name}</div>
              <div className="logo-sub">v{(c.brand || {}).version}</div>
            </span>
          </div>
          <nav className="footer-links">
            {(f.links || []).map((l, i) => <a key={i} href={l.href}>{l.label}</a>)}
          </nav>
        </div>
        <p className="footer-legal">{f.disclaimer}</p>
        <p className="footer-copy">
          © {new Date().getFullYear()} {f.copyright}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
