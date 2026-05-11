/* global React */
const { useState, useEffect, useRef } = React;

function App() {
  const [tab, setTab] = useState("new");
  const [theme, setTheme] = useState("dark");
  const [jobs, setJobs] = useState([]);
  const [history, setHistory] = useState([
    { id: "h1", title: "Big Buck Bunny — Trailer (HD)",      mode: "video", quality: "1080p", when: "11 May 2026, 4:12 PM" },
    { id: "h2", title: "Lo-Fi Beats to Code To · Mix vol. 3", mode: "audio", bitrate: "192",  when: "11 May 2026, 3:48 PM" },
    { id: "h3", title: "Setting up a new MacBook in 2026",    mode: "video", quality: "720p", when: "11 May 2026, 1:02 PM" },
  ]);
  const timers = useRef({});

  useEffect(() => {
    document.body.classList.toggle("light", theme === "light");
  }, [theme]);

  const startJob = ({ url, mode, quality, bitrate }) => {
    const id = "j" + Math.random().toString(36).slice(2, 8);
    const job = {
      id, url, mode, quality: mode === "video" ? quality : null,
      bitrate: mode === "audio" ? bitrate : null,
      title: prettyTitle(url), state: "downloading", percent: 0,
      size: "0.0 MB / —", speed: "—",
    };
    setJobs((j) => [job, ...j]);
    timers.current[id] = setInterval(() => {
      setJobs((arr) => arr.map((x) => {
        if (x.id !== id || x.state !== "downloading") return x;
        const p = Math.min(100, x.percent + (3 + Math.random() * 6));
        const speed = (1 + Math.random() * 4).toFixed(1) + " MiB/s";
        return { ...x, percent: p, speed, size: `${(p * 0.42).toFixed(1)} MB / 42.1 MB` };
      }));
    }, 350);
  };

  useEffect(() => {
    jobs.forEach((j) => {
      if (j.percent >= 100 && j.state === "downloading") {
        clearInterval(timers.current[j.id]);
        setJobs((arr) => arr.map((x) => x.id === j.id ? { ...x, state: "done", speed: "" } : x));
        setHistory((h) => [{ id: j.id, title: j.title, mode: j.mode, quality: j.quality, bitrate: j.bitrate, when: "just now" }, ...h]);
      }
    });
  }, [jobs]);

  const pause = (id) => setJobs((arr) => arr.map((j) => j.id === id
    ? { ...j, state: j.state === "paused" ? "downloading" : "paused" }
    : j));
  const cancel = (id) => {
    clearInterval(timers.current[id]);
    setJobs((arr) => arr.filter((j) => j.id !== id));
  };

  return (
    <>
      <window.Titlebar tab={tab} onTab={setTab} theme={theme} onTheme={setTheme} />
      <main className="main">
        {tab === "new" && (
          <>
            <window.NewDownload onStart={startJob} showWarning={false} />
            <h2 className="section-title">Active Downloads</h2>
            <div className="active-grid">
              {jobs.length === 0
                ? <div className="grid-empty">No active downloads. Paste a URL above to start.</div>
                : jobs.map((j) => <window.JobCard key={j.id} job={j} onPause={pause} onCancel={cancel} />)
              }
            </div>
          </>
        )}
        {tab === "library" && (
          <>
            <h2 className="section-title">Library</h2>
            <div className="library-list">
              {history.map((it) => <window.LibraryRow key={it.id} item={it} />)}
            </div>
          </>
        )}
        {tab === "browser" && (
          <>
            <h2 className="section-title">Browser</h2>
            <div className="placeholder">
              <p>Built-in browser is coming in a future update.</p>
              <p>For now, copy the video URL from your browser and paste it in <strong>New Download</strong>.</p>
            </div>
          </>
        )}
        {tab === "search" && (
          <>
            <h2 className="section-title">Search</h2>
            <div className="placeholder"><p>Cross-site search is coming in a future update.</p></div>
          </>
        )}
      </main>
    </>
  );
}

function prettyTitle(url) {
  if (!url) return "Untitled";
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube") || u.hostname.includes("youtu.be")) return "YouTube video — fetching title…";
    if (u.hostname.includes("tiktok")) return "TikTok clip — fetching title…";
    return u.hostname.replace("www.", "") + " video — fetching title…";
  } catch { return url; }
}

window.VeloxDesktopApp = App;
