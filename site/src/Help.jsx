// The help centre, on its own page at /help.
//
// It is not a section of the landing page: the app's Get help button opens it,
// and someone who clicked that is not shopping — they are stuck. So the page
// opens on the guides, with nothing to scroll past, and everything on it is
// editable in the admin panel because an answer should be able to go up while
// someone is still waiting for it.

import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { youtubeId, youtubeThumb, youtubeEmbed } from './youtube.js';

// What the page shows before anyone edits it, so it is useful the moment it
// goes up. The admin panel overrides all of it.
export const HELP_FALLBACK = {
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

export default function HelpPage() {
  const [content, setContent] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    // A store outage must not take the help page down — that is exactly when
    // people need it — so a failure falls through to the built-in guides.
    api.content()
      .then((r) => setContent((r && r.content) || {}))
      .catch(() => setContent({}));
  }, []);

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

  if (!content) return <div className="center-note">Loading…</div>;

  const brand = content.brand || {};
  const help = content.help && (content.help.articles || content.help.heading) ? content.help : HELP_FALLBACK;
  const articles = (help.articles || []).filter((a) => a && a.title);
  const shown = articles.length ? articles : HELP_FALLBACK.articles;

  return (
    <>
      <header className="help-header">
        <div className="wrap help-header-row">
          <a className="help-brand" href="/">
            <span className="help-logo">V</span>
            <span>{brand.name || 'Velox Downloader'}</span>
          </a>
          <nav className="help-nav">
            <a href="/#pricing">Pricing</a>
            <a href="/">Back to site</a>
          </nav>
        </div>
      </header>

      <main className="help-page">
        <div className="wrap">
          <div className="help-head">
            <div className="eyebrow">Help</div>
            <h1>{help.heading || HELP_FALLBACK.heading}</h1>
            <p>{help.sub || HELP_FALLBACK.sub}</p>
          </div>

          <div className="help-grid">
            {shown.map((a, i) => {
              const vid = youtubeId(a.video);
              // A video brings its own picture, so a guide looks finished
              // without anyone making artwork for it.
              const thumb = a.image || youtubeThumb(vid);
              return (
                <button type="button" className="help-card" key={i} onClick={() => setOpen(a)}>
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
              );
            })}
          </div>

          <div className="help-foot">
            <p>Still stuck? Message us on WhatsApp <b>074 092 0915</b> and we will get you going.</p>
          </div>
        </div>
      </main>

      {open ? <HelpArticle article={open} onClose={() => setOpen(null)} /> : null}
    </>
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
