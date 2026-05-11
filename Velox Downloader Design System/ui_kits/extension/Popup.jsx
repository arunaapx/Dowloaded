/* global React */
const { useState } = React;

function Popup() {
  const [connected, setConnected] = useState(true);
  const [mode, setMode] = useState("video");
  const [quality, setQuality] = useState("1080p");
  const [bitrate, setBitrate] = useState("192");
  const [autoOpen, setAutoOpen] = useState(true);

  return (
    <div className="popup">
      <div className="popup-header">
        <div className="popup-brand">
          <span className="popup-logo">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7v10l10 5 10-5V7L12 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
              <path d="M8 10l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <div>
            <div className="popup-title">Velox</div>
            <div className="popup-sub">Companion · v2.1</div>
          </div>
        </div>
        <div className={"status-chip " + (connected ? "ok" : "err")} onClick={() => setConnected((c) => !c)} title="Click to toggle (demo)">
          <span className="dot"></span>
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>

      {!connected && (
        <div className="popup-banner err">
          <strong>Velox desktop app isn't running.</strong>
          <span>Open it once to enable downloads from this browser.</span>
          <button className="banner-btn">Open Velox</button>
        </div>
      )}

      <div className="popup-section">
        <div className="popup-section-title">Default mode</div>
        <div className="popup-segmented">
          <button className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}>Video</button>
          <button className={mode === "audio" ? "active" : ""} onClick={() => setMode("audio")}>Audio</button>
        </div>
      </div>

      <div className="popup-section">
        <div className="popup-section-title">{mode === "video" ? "Default quality" : "Default bitrate"}</div>
        <div className="popup-pills">
          {mode === "video"
            ? ["4K", "1080p", "720p", "480p"].map((q) => (
                <button key={q} className={"pp" + (quality === q ? " active" : "")} onClick={() => setQuality(q)}>{q}</button>
              ))
            : ["320", "192", "128"].map((b) => (
                <button key={b} className={"pp" + (bitrate === b ? " active" : "")} onClick={() => setBitrate(b)}>{b} kbps</button>
              ))
          }
        </div>
      </div>

      <div className="popup-section row">
        <div>
          <div className="popup-section-title compact">Auto-open menu on detect</div>
          <div className="popup-section-hint">Show the pill the moment a supported video loads</div>
        </div>
        <label className="popup-switch">
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
          <span></span>
        </label>
      </div>

      <div className="popup-footer">
        <button className="popup-link">Open Velox Desktop</button>
        <button className="popup-link muted">Settings…</button>
      </div>
    </div>
  );
}

window.Popup = Popup;
