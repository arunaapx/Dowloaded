/* global React */
const { useState } = React;

function PasteIcon() {
  return <svg viewBox="0 0 24 24"><path d="M9 3h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>;
}

function NewDownload({ onStart, showWarning }) {
  const { PrimaryBtn, GhostBtn, IconBtn, Pill, Segmented, Switch, WarningBanner } = window.Pieces;
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState("video");          // 'video' | 'audio'
  const [quality, setQuality] = useState("1080p");
  const [bitrate, setBitrate] = useState("192");
  const [uiMode, setUiMode] = useState("normal");     // 'normal' | 'advanced'
  const [folder] = useState("C:\\Users\\you\\Downloads");

  const paste = () => setUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

  const start = () => {
    if (!url.trim()) return;
    onStart({ url, mode, quality, bitrate });
    setUrl("");
  };

  return (
    <section className="pane">
      <div className="section-header">
        <h2 className="section-title">New Download</h2>
        <Segmented
          value={uiMode}
          onChange={setUiMode}
          options={[{ value: "normal", label: "Normal" }, { value: "advanced", label: "Advanced" }]}
        />
      </div>

      {showWarning && (
        <WarningBanner>
          <strong>ffmpeg not found.</strong> Required for 1080p+ and MP3. Place <code>ffmpeg.exe</code> in <code>./bin/</code>.
        </WarningBanner>
      )}

      <div className="card download-card">
        <div className="url-row">
          <IconBtn onClick={paste} title="Paste from clipboard"><PasteIcon /></IconBtn>
          <div className="input-block">
            <label>Paste Video URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && start()}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </div>
        </div>

        <div className="options-row">
          <div className="mode-group">
            <div className="mode-toggle">
              <Switch checked={mode === "video"} onChange={(v) => setMode(v ? "video" : "audio")} />
              <span className="mode-label">Video (MP4)</span>
            </div>
            <div className="mode-toggle">
              <Switch checked={mode === "audio"} onChange={(v) => setMode(v ? "audio" : "video")} />
              <span className="mode-label">Audio (MP3)</span>
            </div>
          </div>
          <PrimaryBtn onClick={start} disabled={!url.trim()}>START DOWNLOAD</PrimaryBtn>
        </div>

        <div className="quality-row">
          {mode === "video" ? (
            <div className="quality-group">
              {["4k", ...(uiMode === "advanced" ? ["1440p"] : []), "1080p", "720p", ...(uiMode === "advanced" ? ["480p", "360p"] : [])].map((q) => (
                <Pill key={q} active={quality === q} onClick={() => setQuality(q)}>
                  {q === "4k" ? "4K" : q}
                </Pill>
              ))}
            </div>
          ) : (
            <div className="quality-group">
              {["320", "192", "128"].map((b) => (
                <Pill key={b} active={bitrate === b} onClick={() => setBitrate(b)}>{b}kbps</Pill>
              ))}
            </div>
          )}
        </div>

        {uiMode === "advanced" && (
          <div className="advanced-panel">
            <div className="adv-block">
              <div className="adv-block-title">{mode === "video" ? "Format & codec" : "Audio"}</div>
              <div className="adv-grid">
                {mode === "video" ? (
                  <>
                    <label className="adv-field">
                      <span>Container</span>
                      <select defaultValue="mp4"><option value="mp4">MP4 (H.264 friendly)</option><option value="mkv">MKV</option><option value="webm">WEBM (VP9/AV1)</option></select>
                    </label>
                    <label className="adv-field">
                      <span>Video codec</span>
                      <select defaultValue="auto"><option value="auto">Auto (best available)</option><option value="h264">H.264 (avc1)</option><option value="av1">AV1</option><option value="vp9">VP9</option></select>
                    </label>
                    <label className="adv-field">
                      <span>Max video bitrate <em>auto</em></span>
                      <input type="range" min="0" max="20000" step="250" defaultValue="0" />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="adv-field">
                      <span>Audio format</span>
                      <select defaultValue="mp3"><option value="mp3">MP3</option><option value="m4a">M4A (AAC)</option><option value="opus">OPUS</option><option value="flac">FLAC (lossless)</option></select>
                    </label>
                    <label className="adv-field">
                      <span>Audio bitrate <em>{bitrate} kbps</em></span>
                      <input type="range" min="32" max="320" step="16" value={bitrate} onChange={(e) => setBitrate(e.target.value)} />
                    </label>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="folder-row">
          <span className="folder-label">Save to:</span>
          <span className="folder-path">{folder}</span>
          <GhostBtn>Change…</GhostBtn>
          <GhostBtn title="Open folder">📂</GhostBtn>
        </div>
      </div>
    </section>
  );
}

window.NewDownload = NewDownload;
