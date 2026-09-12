import React, { useEffect, useRef, useState } from 'react';
import { api, detectOS } from './api.js';
import { youtubeId, youtubeThumb, youtubeEmbed } from './youtube.js';

/* ---------------------------------------------------------------- content
   Everything here can be overridden by the store's /content endpoint, which is
   what the admin panel edits. These are the defaults the page falls back to, so
   a store outage still renders a complete site rather than a page of blanks -
   and so new sections work before anyone opens the admin panel. */

const FALLBACK = {
  version: '2.3.0',
  headline: 'Every video, at full speed.',
  headlineAccent: 'Eight streams at once.',
  sub: 'Velox splits each download across parallel connections and rebuilds the file when they land. Playlists, whole channels, 4K, MP3 - from a thousand sites.',
  features: [
    { t: 'Parallel downloads', b: 'Each file is split and fetched over several connections at once, then merged back together.', i: 'bolt' },
    { t: 'Playlists and channels', b: 'Paste a playlist and pick a range. Every video queues as its own job with its own folder.', i: 'list', isNew: true },
    { t: 'Search without leaving', b: 'Search YouTube and 13 other sites from inside the app - videos or whole playlists.', i: 'search', isNew: true },
    { t: 'A queue you can see', b: 'Every waiting download has a card, a position, and a place in line you can drag it out of.', i: 'queue', isNew: true },
    { t: 'Start it tonight', b: 'Hold the queue and set a time. Built for night-time data packages.', i: 'clock', isNew: true },
    { t: 'Speed limit', b: 'Cap the download so the rest of the house can still use the internet.', i: 'gauge', isNew: true },
    { t: 'Built-in browser', b: 'Browse inside Velox and take a video with one button - or every video linked on the page.', i: 'globe' },
    { t: 'Browser extension', b: 'A Chrome and Edge extension hands links straight to the app from any page you are already on.', i: 'plug' },
    { t: 'Clipboard aware', b: 'Copy a link anywhere and Velox offers to take it. It asks - it never grabs on its own.', i: 'clip', isNew: true },
    { t: '4K, 8K and MP3', b: 'Pick the quality you want, or pull just the audio at full bitrate.', i: 'film' },
    { t: 'Torrents too', b: 'Magnet links and .torrent files, with seeds, peers and speed in the same window.', i: 'share' },
    { t: 'Survives a dropped line', b: 'A cut connection resumes from the bytes already on disk instead of starting over.', i: 'shield' },
  ],
  numbers: [
    { n: '8', l: 'parallel connections', note: 'per download' },
    { n: '6.2×', l: 'faster than one stream', note: 'measured, 77 MB file' },
    { n: '1000+', l: 'supported sites', note: 'video and audio' },
    { n: '4K', l: 'and 8K where offered', note: 'video + audio merged' },
  ],
  steps: [
    { t: 'Paste, or just copy', b: 'Drop in a link, or copy one anywhere and let Velox offer to take it.' },
    { t: 'Pick what you want', b: 'Quality, MP3, a range of a playlist, or everything linked on a page.' },
    { t: 'It queues and runs', b: 'Jobs run a few at a time, resume after a drop, and land in the right folder.' },
  ],
  sites: ['YouTube', 'Facebook', 'Instagram', 'TikTok', 'X', 'Vimeo', 'Dailymotion', 'Twitch', 'SoundCloud', 'Reddit', 'Odysee', 'BitChute', 'Bilibili', 'Niconico'],
  faq: [
    { q: 'Is it really faster, or is that marketing?', a: 'The same 77 MB file measured 0.92 MB/s on one connection and 5.68 MB/s on eight. Velox uses four on YouTube on purpose: past that, YouTube starts treating the traffic as a bot and refuses the download entirely, which is slower than any number of connections.' },
    { q: 'Do my files go through your servers?', a: 'No. Downloads run on your machine and go straight from the site to your disk. The only thing our server does is check your licence.' },
    { q: 'What happens if my internet drops?', a: 'The download resumes from the bytes already written. Nothing restarts from zero, and the queue keeps its place.' },
    { q: 'Does it update itself?', a: 'Yes. Velox checks for a new version and installs it in place. Sites change constantly, so an out-of-date copy is the most common reason a download fails.' },
  ],
};

/* ------------------------------------------------------------------ icons */

const ICONS = {
  bolt:   <path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" />,
  list:   <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1.4" /><circle cx="3.5" cy="12" r="1.4" /><circle cx="3.5" cy="18" r="1.4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  queue:  <><rect x="3" y="4" width="18" height="4" rx="1.5" /><rect x="3" y="11" width="18" height="4" rx="1.5" /><rect x="3" y="18" width="11" height="3" rx="1.5" /></>,
  clock:  <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></>,
  gauge:  <><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-5" /></>,
  globe:  <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" /></>,
  plug:   <><path d="M9 3v6M15 3v6" /><path d="M6 9h12v3a6 6 0 0 1-12 0V9z" /><path d="M12 18v3" /></>,
  clip:   <><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3" /></>,
  film:   <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 12h18" /></>,
  share:  <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 10.6l6.8-4.2M8.6 13.4l6.8 4.2" /></>,
  shield: <><path d="M12 3l8 3.5v5c0 5-3.4 9-8 10.5-4.6-1.5-8-5.5-8-10.5v-5L12 3z" /><path d="M9 12l2 2 4-4" /></>,
};

const Icon = ({ name, size = 19 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name] || ICONS.bolt}
  </svg>
);

const LogoMark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" />
  </svg>
);
const DownIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
  </svg>
);
const WhatsAppGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.8 14.06c-.24.68-1.4 1.3-1.94 1.38-.5.07-1.13.1-1.82-.11-.42-.13-.96-.31-1.65-.61-2.9-1.25-4.8-4.17-4.94-4.37-.15-.2-1.18-1.57-1.18-3s.75-2.13 1.02-2.42c.27-.29.58-.36.78-.36.19 0 .39 0 .56.01.18.01.42-.07.66.5.24.58.82 2 .89 2.15.07.15.12.32.02.51-.1.2-.15.32-.29.49-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.29.76 1.25 1.63 2.03 1.12 1 2.06 1.31 2.35 1.46.29.15.46.12.63-.07.17-.2.73-.85.93-1.14.19-.29.39-.24.65-.15.27.1 1.69.8 1.98.94.29.15.48.22.55.34.07.12.07.68-.17 1.36z" />
  </svg>
);

/* ------------------------------------------------------------- reveal hook
   Elements start visible in CSS. This opts them in to the animation and then
   plays it, so a blocked or broken bundle leaves a readable page. */

function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver !== 'function') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    el.classList.add('will-reveal');
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      el.classList.add('revealed');
      io.disconnect();
    }, { rootMargin: '0px 0px -12% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

const Reveal = ({ children, className = '', ...rest }) => {
  const ref = useReveal();
  return <div ref={ref} className={className} {...rest}>{children}</div>;
};

/* ------------------------------------------------------------------- page */

export default function App() {
  const [content, setContent] = useState(null);
  const [stats, setStats] = useState(null);
  const [plans, setPlans] = useState([]);
  const os = detectOS();

  useEffect(() => {
    // A store outage must not take the marketing site down with it, so a
    // failure falls through to the defaults instead of an error screen. The
    // pricing tiers come from the licence server rather than the store, and
    // are treated the same way: if they cannot be read, the page falls back to
    // the single price in the store content.
    Promise.all([
      api.content().catch(() => null),
      api.stats().catch(() => null),
      api.plans().catch(() => null),
    ])
      .then(([c, s, p]) => {
        setContent((c && c.content) || {});
        if (s) setStats(s);
        if (p && Array.isArray(p.plans)) setPlans(p.plans);
      })
      .catch(() => setContent({}));
  }, []);

  useEffect(() => {
    let timer = null;
    let stopped = false;
    let inFlight = false;

    const tick = () => {
      // Never stack requests: a slow reply must not queue a second one behind
      // it, which is how a one-second poll turns into a flood.
      if (inFlight) return schedule();
      inFlight = true;
      api.stats()
        .then((s) => { if (s && !stopped) setStats(s); })
        .catch(() => {})
        .finally(() => { inFlight = false; if (!stopped) schedule(); });
    };

    // Every second while the tab is in front; every half minute when it is not.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, document.hidden ? 30000 : 1000);
    };

    const onVisibility = () => { if (!document.hidden) tick(); else schedule(); };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!content) return <div className="center-note">Loading…</div>;

  return (
    <>
      <Nav c={content} os={os} />
      <main>
        <Hero c={content} os={os} stats={stats} setStats={setStats} />
        <Numbers c={content} />
        <Features c={content} />
        <HowItWorks c={content} />
        <Sites c={content} />
        <Extension c={content} />
        <Pricing c={content} stats={stats} plans={plans} />
        <Help c={content} />
        <Faq c={content} />
      </main>
      <Footer c={content} />
    </>
  );
}

/* -------------------------------------------------------------------- nav */

function Nav({ c, os }) {
  const brand = c.brand || {};
  const nav = c.nav || {};
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const links = nav.links && nav.links.length ? nav.links : [
    { label: 'Features', href: '#features' },
    { label: 'How it works', href: '#how' },
    { label: 'Sites', href: '#sites' },
    { label: 'Extension', href: '#extension' },
    { label: 'Help', href: '#help' },
    { label: 'Pricing', href: '#pricing' },
  ];

  return (
    <header className={`nav${stuck ? ' stuck' : ''}`}>
      <div className="wrap nav-inner">
        <a className="logo" href="#top">
          <span className="logo-mark"><LogoMark /></span>
          <span>
            <div className="logo-name">{brand.name || 'Velox Downloader'}</div>
            <div className="logo-sub">{brand.tagline || 'Fast, private, yours'}</div>
          </span>
        </a>
        <nav className="nav-links">
          {links.map((l, i) => <a key={i} href={l.href}>{l.label}</a>)}
        </nav>
        <div className="nav-right">
          <span className="os-badge">v{brand.version || FALLBACK.version} for {os}</span>
          <a className="btn primary sm" href="#pricing">{nav.cta || 'Get Velox'}</a>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------- hero */

function Hero({ c, os, stats, setStats }) {
  const h = c.hero || {};
  const brand = c.brand || {};
  const downloadUrl = h.downloadUrl || '/download/VeloxDownloader.exe';

  const onDownload = () => {
    // The counter is the honest number of clicks on this button. It must never
    // stand between the user and the file, so failures are swallowed.
    api.countDownload()
      .then((r) => setStats((s) => ({ ...(s || {}), downloads: r.downloads })))
      .catch(() => {});
  };

  return (
    <section className="hero" id="top">
      <div className="wrap hero-grid">
        <div>
          <div className="eyebrow">For {os}</div>
          <h1>
            {h.headline || FALLBACK.headline}{' '}
            <span className="accent">{h.headlineAccent || FALLBACK.headlineAccent}</span>
          </h1>
          <p className="hero-sub">{h.sub || FALLBACK.sub}</p>

          <div className="hero-cta">
            <a className="btn primary" href={downloadUrl} onClick={onDownload}>
              <DownIcon />
              {h.primaryCta || `Download for ${os}`}
            </a>
            <a className="btn ghost" href="#features">See what it does</a>
          </div>

          <div className="hero-micro">
            v{brand.version || FALLBACK.version} · no ads, no bundled software · updates itself
          </div>

          <HeroStats stats={stats} />
        </div>

        <Machine />
      </div>
    </section>
  );
}

function HeroStats({ stats }) {
  const downloads = Number(stats && stats.downloads) || 0;
  const known = stats != null;
  return (
    <div className="hero-stats">
      <div>
        <div className="hstat-num">
          <Count to={downloads} />
          {known ? <span className="live-dot" title="Updating live" /> : null}
        </div>
        <div className="hstat-label">downloads{known ? ' · live' : ''}</div>
      </div>
      <div>
        <div className="hstat-num">6.2×</div>
        <div className="hstat-label">faster than one connection</div>
      </div>
      <div>
        <div className="hstat-num">1000+</div>
        <div className="hstat-label">supported sites</div>
      </div>
    </div>
  );
}

/* The hero visual: what the downloader actually does, drawn. Eight lanes fill
   together while a single connection crawls underneath - which is the whole
   argument for the product, and the measured difference between them. */
function Machine() {
  return (
    <div className="machine" aria-hidden="true">
      <div className="machine-top">
        <span className="dot live" />
        <span className="dot" />
        <span className="dot" />
        <span className="machine-title">interstellar-trailer-4k.mp4</span>
        <span className="machine-speed">5.68 MB/s</span>
      </div>

      <div className="lanes">
        {Array.from({ length: 8 }, (_, i) => (
          <div className="lane" key={i}>
            <span className="lane-tag">part {i + 1}</span>
            <span className="lane-track"><span className="lane-fill" /></span>
          </div>
        ))}
      </div>

      <div className="machine-compare">
        <div className="compare-label">the same file, one connection</div>
        <div className="lane slow">
          <span className="lane-tag">single</span>
          <span className="lane-track"><span className="lane-fill" /></span>
        </div>
      </div>

      <div className="machine-foot">
        <span className="merge-pill">MERGED</span>
        <span>Parts are rebuilt into one file when they land.</span>
      </div>
    </div>
  );
}

/* A number that counts up once, when it first has a value to show. */
function Count({ to }) {
  const [n, setN] = useState(0);
  const from = useRef(0);
  const seeded = useRef(false);
  const [bumped, setBumped] = useState(false);

  useEffect(() => {
    const target = Number(to) || 0;
    const start = from.current;
    from.current = target;
    if (target === start) return undefined;

    // The first real figure appears as itself. Counting 0 -> 65 on every page
    // load is theatre: nothing happened, so nothing should move. Only a genuine
    // change - someone downloading while this page is open - animates.
    if (!seeded.current) {
      seeded.current = true;
      setN(target);
      return undefined;
    }

    const jump = Math.abs(target - start);
    const ms = Math.min(600, 140 + jump * 60);
    setBumped(true);
    const clear = setTimeout(() => setBumped(false), 700);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(target);
      return undefined;
    }
    let raf;
    const began = performance.now();
    const run = (now) => {
      const p = Math.min(1, (now - began) / ms);
      // Ease out, so it arrives rather than stopping dead.
      setN(Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => { cancelAnimationFrame(raf); clearTimeout(clear); };
  }, [to]);

  return <span className={bumped ? 'count-bump' : undefined}>{n.toLocaleString()}</span>;
}

/* ---------------------------------------------------------------- numbers */

function Numbers({ c }) {
  const nums = (c.numbers && c.numbers.length ? c.numbers : FALLBACK.numbers);
  return (
    <section className="section">
      <div className="wrap">
        <Reveal className="band">
          {nums.map((x, i) => (
            <div className="band-cell" key={i}>
              <div className="band-num">{x.n}</div>
              <div className="band-label">{x.l}</div>
              {x.note ? <div className="band-note">{x.note}</div> : null}
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- features */

function Features({ c }) {
  const list = (c.features && c.features.length ? c.features : FALLBACK.features);
  return (
    <section className="section alt" id="features">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">Everything in the app</div>
          <h2>Built for the way people actually download</h2>
          <p>Not a list of checkboxes — each of these exists because something was slow, broke, or could not be seen.</p>
        </Reveal>

        <div className="feat-grid">
          {list.map((f, i) => (
            <Reveal className="feat" key={i} style={{ transitionDelay: `${Math.min(i, 8) * 45}ms` }}>
              {f.isNew ? <span className="tag-new">NEW</span> : null}
              <span className="feat-ico"><Icon name={f.i} /></span>
              <h3>{f.t}</h3>
              <p>{f.b}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- how it works */

function HowItWorks({ c }) {
  const steps = (c.steps && c.steps.length ? c.steps : FALLBACK.steps);
  return (
    <section className="section" id="how">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">How it works</div>
          <h2>Three steps, and one of them is optional</h2>
        </Reveal>
        <div className="steps">
          {steps.map((s, i) => (
            <Reveal className="step" key={i} style={{ transitionDelay: `${i * 90}ms` }}>
              <div className="step-n">{String(i + 1).padStart(2, '0')}</div>
              <h3>{s.t}</h3>
              <p>{s.b}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ sites */

function Sites({ c }) {
  const sites = (c.sites && c.sites.length ? c.sites : FALLBACK.sites);
  return (
    <section className="section alt" id="sites">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">Where it works</div>
          <h2>Over a thousand sites, searchable from inside</h2>
          <p>These are the ones you can search without leaving Velox. Everything else works by pasting a link.</p>
        </Reveal>
        <Reveal className="chips">
          {sites.map((s, i) => <span className="chip" key={i}>{s}</span>)}
          <span className="chip more">+ 1000 more</span>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- extension
   Not on the Chrome Web Store, so it installs from a folder. That is four
   steps and a developer-mode switch, and pretending otherwise just produces
   people who download a zip and get stuck - so the steps are the section. */

function Extension({ c }) {
  const e = c.extension || {};
  const url = e.url || '/download/velox-extension.zip';
  const steps = e.steps && e.steps.length ? e.steps : [
    'Download the zip and unzip it somewhere you will keep it — Chrome loads it from that folder every time it starts.',
    'Open chrome://extensions in a new tab.',
    'Turn on Developer mode, top right.',
    'Click "Load unpacked" and choose the velox-extension folder.',
  ];

  return (
    <section className="section" id="extension">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">Browser extension</div>
          <h2>{e.heading || 'Take a video from the page you are already on'}</h2>
          <p>{e.sub || 'A download button appears on videos as you browse. Clicking it hands the link to Velox, which does the work. Chrome, Edge, Brave and Opera.'}</p>
        </Reveal>

        <div className="ext-grid">
          <Reveal className="ext-steps">
            {steps.map((t, i) => (
              <div className="ext-step" key={i}>
                <span className="ext-n">{i + 1}</span>
                <p>{t}</p>
              </div>
            ))}
            <a className="btn primary" href={url} style={{ marginTop: 20 }}>
              <DownIcon />
              Download the extension
            </a>
            <p className="ext-note">
              Velox has to be running for the button to work — the extension hands
              links to the app on your own machine and never to a server.
            </p>
          </Reveal>

          <Reveal className="ext-card">
            <div className="ext-bar">
              <span className="dot" /><span className="dot" /><span className="dot" />
              <span className="ext-url">youtube.com/watch</span>
            </div>
            <div className="ext-stage">
              <div className="ext-video">
                <span className="ext-play">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><polygon points="8,5 19,12 8,19" /></svg>
                </span>
                <span className="ext-btn"><DownIcon /> Download</span>
              </div>
              <div className="ext-caption">The button the extension adds, on the page itself.</div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- pricing */

function Pricing({ c, stats, plans = [] }) {
  const p = c.pricing || {};
  const rows = p.rows && p.rows.length ? p.rows : [
    { feature: 'Downloads', free: '150 free', pro: 'Unlimited' },
    { feature: 'Quality', free: 'Up to 1080p', pro: '4K and 8K where offered' },
    { feature: 'Playlists and channels', free: '—', pro: 'Whole playlists, pick a range' },
    { feature: 'Queue and scheduling', free: '—', pro: 'Queue, hold, start at a set time' },
    { feature: 'Torrents', free: '—', pro: 'Magnets and .torrent files' },
    { feature: 'Updates', free: 'Included', pro: 'Included' },
  ];

  return (
    <section className="section" id="pricing">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">Pricing</div>
          <h2>{p.heading || 'Try it free. Buy it when it earns its keep.'}</h2>
          <p>{p.sub || 'The free version is the whole app with a download limit, not a crippled demo.'}</p>
        </Reveal>

        <div className="pricing-wrap">
          <Reveal className="compare-scroll">
            <table className="cmp">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>{p.freeLabel || 'Free'}</th>
                  <th className="pro">{p.proLabel || 'Pro'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.feature}</td>
                    <td>{r.free}</td>
                    <td className="pro">{r.pro}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
          {plans.length ? <PlanCards plans={plans} p={p} /> : <BuyCard p={p} />}
        </div>
      </div>
    </section>
  );
}

/* The tiers as published in the licence admin panel. Editing a price there
   changes it here and in the app at the same time — there is no second copy of
   the pricing to keep in step. */
function PlanCards({ plans, p }) {
  return (
    <div className="plan-cards">
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} p={p} />
      ))}
    </div>
  );
}

function PlanCard({ plan, p }) {
  // Card payments are still not switched on, so a plan with no buy link of its
  // own goes down the same WhatsApp route as before — it just names the tier
  // the buyer asked for, so the right key gets issued.
  const WHATSAPP = '94740920915';
  const product = p.product || 'Velox Downloader Pro';
  const fallback = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Hi, I would like to buy ${product} — ${plan.name}.`)}`;
  const href = plan.buyUrl || fallback;
  const devices = Number(plan.devices) || 1;

  return (
    <aside className={'buy-card plan-card' + (plan.highlight ? ' featured' : '')}>
      {plan.highlight ? <div className="plan-badge">Most popular</div> : null}
      <div className="plan-title">{plan.name}</div>
      <div className="price-tag">
        <span className="price-amount">{plan.price}</span>
        <span className="price-per">{plan.period}</span>
      </div>
      <div className="plan-devices">{devices} device{devices === 1 ? '' : 's'}</div>

      {plan.features && plan.features.length ? (
        <ul className="plan-list">
          {plan.features.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      ) : null}

      <a className="btn primary wide" href={href} target="_blank" rel="noreferrer" style={{ marginTop: 16 }}>
        {plan.buyUrl ? 'Buy now' : <><WhatsAppGlyph />Buy on WhatsApp</>}
      </a>
      {plan.buyUrl ? null : (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 12 }}>
          Message us and we will send your licence key, usually within a few hours.
        </p>
      )}
    </aside>
  );
}

function BuyCard({ p }) {
  // Card payments are not switched on yet, so buying runs through WhatsApp: the
  // buyer messages us, we settle it however suits them, and the key is issued by
  // hand from the admin panel. The PayHere plumbing stays in the store service,
  // dormant, for when a gateway is ready.
  const WHATSAPP = '94740920915'; // 074 092 0915 in international form
  const product = p.product || 'Velox Downloader Pro';
  const href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Hi, I would like to buy ${product}.`)}`;

  return (
    <aside className="buy-card">
      <div className="price-tag">
        <span className="price-amount">{p.currency ? `${p.currency} ` : ''}{p.price != null ? p.price : '—'}</span>
        <span className="price-per">{p.period || 'per year'}</span>
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 14.2, marginTop: 6 }}>{product}</p>

      <a className="btn primary wide" href={href} target="_blank" rel="noreferrer" style={{ marginTop: 18 }}>
        <WhatsAppGlyph />
        Buy on WhatsApp
      </a>

      <p style={{ color: 'var(--text-dim)', fontSize: 13.2, marginTop: 14 }}>
        Message us and we will send your licence key, usually within a few hours.
      </p>
      <p style={{ color: 'var(--text-faint)', fontSize: 13.2, marginTop: 4 }}>
        WhatsApp <b style={{ color: 'var(--text-dim)' }}>074 092 0915</b>
      </p>
    </aside>
  );
}

/* ------------------------------------------------------------------- help */

// The guides a brand-new install shows, so the help centre is useful the
// moment it goes up rather than empty until someone writes something. The
// admin panel overrides all of it; the first edit saves the whole section.
const HELP_FALLBACK = {
  heading: 'Help Center',
  sub: 'Short answers to the things people ask most. Every guide takes a minute.',
  articles: [
    {
      title: 'Activating Velox on your PC',
      description:
        'Enter your email twice, tick the box, and the key arrives in your inbox. The licence locks to this computer, so use the machine you will actually download on.',
      image: '',
      video: '',
    },
    {
      title: 'Why my key will not work on a second computer',
      description:
        "A licence is tied to one machine's hardware. Reinstalling Windows or the app is fine — the same PC stays the same PC. A new motherboard counts as a new machine; message us and we will move it across.",
      image: '',
      video: '',
    },
    {
      title: 'Downloading a whole playlist',
      description:
        'Paste the playlist link, or search and press Open playlist. Pick the episodes you want, choose video or MP3, and each one is queued as its own download with its own progress.',
      image: '',
      video: '',
    },
    {
      title: 'Torrents: picking files before they download',
      description:
        'Add a magnet or a .torrent file and Velox reads the file list first. Tick only what you want — language packs and extras can stay behind — then press Start download.',
      image: '',
      video: '',
    },
  ],
};

function Help({ c }) {
  const help = c.help && (c.help.articles || c.help.heading) ? c.help : HELP_FALLBACK;
  const articles = (help.articles || []).filter((a) => a && a.title);
  const [open, setOpen] = useState(null);

  // Escape closes, and the page behind stops scrolling while a guide is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!articles.length) return null;

  return (
    <section className="section" id="help">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">Help</div>
          <h2>{help.heading || HELP_FALLBACK.heading}</h2>
          <p>{help.sub || HELP_FALLBACK.sub}</p>
        </Reveal>

        <div className="help-grid">
          {articles.map((a, i) => {
            const vid = youtubeId(a.video);
            // A video brings its own picture, so a guide looks finished without
            // anyone having to make artwork for it.
            const thumb = a.image || youtubeThumb(vid);
            return (
              <Reveal key={i}>
                <button type="button" className="help-card" onClick={() => setOpen(a)}>
                  {thumb ? (
                    <span className="help-thumb">
                      <img src={thumb} alt="" loading="lazy" />
                      {vid ? <span className="help-play" aria-hidden="true">▶</span> : null}
                    </span>
                  ) : null}
                  <span className="help-text">
                    <span className="help-title">{a.title}</span>
                    <span className="help-desc">{a.description}</span>
                  </span>
                </button>
              </Reveal>
            );
          })}
        </div>
      </div>

      {open ? <HelpArticle article={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function HelpArticle({ article, onClose }) {
  const vid = youtubeId(article.video);
  return (
    <div className="help-modal" onClick={onClose} role="dialog" aria-modal="true" aria-label={article.title}>
      <div className="help-modal-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="help-close" onClick={onClose} aria-label="Close">×</button>
        <h3>{article.title}</h3>

        {vid ? (
          <div className="help-video">
            <iframe
              src={youtubeEmbed(vid)}
              title={article.title}
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : article.image ? (
          <img className="help-image" src={article.image} alt="" />
        ) : null}

        {article.description ? <p className="help-body">{article.description}</p> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- faq */

function Faq({ c }) {
  const items = (c.faq && c.faq.length ? c.faq : FALLBACK.faq);
  const [open, setOpen] = useState(0);
  return (
    <section className="section alt">
      <div className="wrap">
        <Reveal className="section-head">
          <div className="eyebrow">Questions</div>
          <h2>The ones worth answering honestly</h2>
        </Reveal>
        <Reveal className="faq-list">
          {items.map((f, i) => (
            <div className={`faq-item${open === i ? ' open' : ''}`} key={i}>
              <button
                type="button"
                className="faq-q"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? -1 : i)}
              >
                {f.q}
                <svg className="caret" viewBox="0 0 24 24" width="17" height="17" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <div className="faq-a"><div><p>{f.a}</p></div></div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- footer */

function Footer({ c }) {
  const f = c.footer || {};
  const brand = c.brand || {};
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <span className="logo-mark" style={{ width: 28, height: 28 }}><LogoMark /></span>
        <p>{f.copyright || `© ${new Date().getFullYear()} ${brand.name || 'Velox Downloader'}`}</p>
        <div className="footer-links">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="/download/VeloxDownloader.exe">Download</a>
        </div>
      </div>
    </footer>
  );
}
