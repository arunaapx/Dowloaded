/* global React */

function FilmIcon() {
  return <svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16v12H4z" stroke="currentColor" strokeWidth="1.6" /><path d="M10 9l5 3-5 3V9z" fill="currentColor" /></svg>;
}
function PauseIcon() { return <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>; }
function CancelIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>; }
function FolderIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>; }

function JobCard({ job, onPause, onCancel }) {
  const stateLabel = job.state === "done" ? "Done" :
                     job.state === "error" ? "Failed" :
                     job.state === "paused" ? "Paused" :
                     `${Math.round(job.percent)}%`;
  return (
    <div className={"job " + job.state}>
      <div className="job-body">
        <div className="job-thumb">
          <span className="placeholder-icon"><FilmIcon /></span>
          <span className="badge">{job.mode === "audio" ? "MP3" : (job.quality || "best").toUpperCase()}</span>
        </div>
        <div className="job-info">
          <div className="job-header">
            <span className="job-title">{job.title}</span>
            <span className={"job-state " + (job.state === "done" ? "done" : job.state === "error" ? "error" : job.state === "paused" ? "paused" : "")}>{stateLabel}</span>
          </div>
          <div className="bar"><div className="bar-fill" style={{ width: `${job.percent}%` }} /></div>
          <div className="job-meta">
            <span>{job.size || "—"}</span>
            <span>{job.speed || "—"}</span>
          </div>
        </div>
      </div>
      <div className="job-controls">
        <span className="controls-label">Controls</span>
        {job.state !== "done" && job.state !== "error" && (
          <button className="ctrl-btn" onClick={() => onPause(job.id)}>
            <PauseIcon /> <span>{job.state === "paused" ? "Resume" : "Pause"}</span>
          </button>
        )}
        {job.state !== "done" && (
          <button className="ctrl-btn danger" onClick={() => onCancel(job.id)}>
            <CancelIcon /> Cancel
          </button>
        )}
        <button className="ctrl-btn"><FolderIcon /> Open Folder</button>
      </div>
    </div>
  );
}

function LibraryRow({ item }) {
  return (
    <div className="lib-item">
      <div className="lib-thumb"><FilmIcon /></div>
      <div className="lib-info">
        <div className="lib-title">{item.title}</div>
        <div className="lib-sub">{item.mode === "audio" ? "MP3 " + (item.bitrate || "") : (item.quality || "")} · {item.when}</div>
      </div>
      <div className="lib-actions">
        <button className="ghost-btn">Open</button>
        <button className="ghost-btn">Folder</button>
      </div>
    </div>
  );
}

window.JobCard = JobCard;
window.LibraryRow = LibraryRow;
