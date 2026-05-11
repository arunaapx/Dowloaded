/* global React */
const { useState } = React;

function LogoTile() {
  return (
    <div className="logo">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 2L2 7v10l10 5 10-5V7L12 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 10l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

const navIcons = {
  library: <svg className="ico" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>,
  browser: <svg className="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>,
  search: <svg className="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>,
  settings: <svg className="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>,
};

function Titlebar({ tab, onTab, theme, onTheme }) {
  const tabs = [
    { id: "new",     label: "New Download", icon: null },
    { id: "library", label: "Library",      icon: navIcons.library },
    { id: "browser", label: "Browser",      icon: navIcons.browser },
    { id: "search",  label: "Search",       icon: navIcons.search },
  ];
  return (
    <div className="titlebar">
      <div className="brand">
        <LogoTile />
        <div className="title">Velox Downloader <span className="version">v2.1</span></div>
      </div>
      <nav className="nav">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={"nav-btn" + (tab === t.id ? " active" : "")}
            onClick={() => onTab(t.id)}
          >
            {t.icon}{t.icon ? " " : ""}{t.label}
          </button>
        ))}
        <button className="nav-btn icon-only" title="Settings">{navIcons.settings}</button>
      </nav>
      <div className="theme-wrap">
        <span className="theme-label">Theme</span>
        <window.Pieces.Switch small checked={theme === "dark"} onChange={(v) => onTheme(v ? "dark" : "light")} />
      </div>
      <div className="win-ctrls" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </div>
  );
}

window.Titlebar = Titlebar;
