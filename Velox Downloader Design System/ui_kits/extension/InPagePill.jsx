/* global React */
const { useState, useRef, useEffect } = React;

function InPagePill({ defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [toast, setToast] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const send = (mode, qualityOrBitrate) => {
    setOpen(false);
    setToast({ kind: "ok", text: mode === "video"
      ? `Sent to Velox · ${qualityOrBitrate}`
      : `Sent to Velox · MP3 · ${qualityOrBitrate} kbps` });
    setTimeout(() => setToast(null), 2400);
  };

  return (
    <div className="velox-pill-wrap" ref={ref}>
      <button className={"velox-pill" + (open ? " open" : "")} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>Download</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="velox-menu" role="menu">
          <div className="menu-section">Video</div>
          <button className="mi" onClick={() => send("video", "4K")}><span className="mi-icon">🎬</span>4K<span className="mi-meta">MP4</span></button>
          <button className="mi" onClick={() => send("video", "1080p")}><span className="mi-icon">🎬</span>1080p<span className="mi-meta">MP4 · recommended</span></button>
          <button className="mi" onClick={() => send("video", "720p")}><span className="mi-icon">🎬</span>720p<span className="mi-meta">MP4</span></button>
          <div className="menu-sep" />
          <div className="menu-section">Audio only</div>
          <button className="mi" onClick={() => send("audio", "320")}><span className="mi-icon">🎵</span>MP3 · 320 kbps</button>
          <button className="mi" onClick={() => send("audio", "192")}><span className="mi-icon">🎵</span>MP3 · 192 kbps</button>
          <div className="menu-sep" />
          <button className="mi muted">Open Velox Desktop…</button>
        </div>
      )}
      {toast && (
        <div className={"velox-toast " + toast.kind}>
          <span className="dot"></span>{toast.text}
        </div>
      )}
    </div>
  );
}

window.InPagePill = InPagePill;
