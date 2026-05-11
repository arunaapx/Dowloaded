/* global React */
const { useState } = React;

/* ============ Primary button ============ */
function PrimaryBtn({ children, onClick, disabled }) {
  return (
    <button className="primary-btn" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/* ============ Ghost button ============ */
function GhostBtn({ children, onClick, title }) {
  return (
    <button className="ghost-btn" onClick={onClick} title={title}>{children}</button>
  );
}

/* ============ Icon button (44px square) ============ */
function IconBtn({ children, onClick, title }) {
  return (
    <button className="icon-btn" onClick={onClick} title={title}>{children}</button>
  );
}

/* ============ Pill (quality / bitrate) ============ */
function Pill({ active, onClick, children }) {
  return (
    <button className={"pill" + (active ? " active" : "")} onClick={onClick}>
      {children}
    </button>
  );
}

/* ============ Segmented switch (Normal / Advanced) ============ */
function Segmented({ value, options, onChange }) {
  return (
    <div className="mode-switch" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          className={"seg-btn" + (value === o.value ? " active" : "")}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ============ Toggle switch (iOS-style, gradient when on) ============ */
function Switch({ checked, onChange, small }) {
  return (
    <label className={"switch" + (small ? " small" : "")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider"></span>
    </label>
  );
}

/* ============ Empty state used inside grids ============ */
function EmptyHint({ children }) {
  return <div className="empty-hint">{children}</div>;
}

/* ============ Warning banner (used for missing binaries) ============ */
function WarningBanner({ children }) {
  return <div className="warning">{children}</div>;
}

window.Pieces = { PrimaryBtn, GhostBtn, IconBtn, Pill, Segmented, Switch, EmptyHint, WarningBanner };
