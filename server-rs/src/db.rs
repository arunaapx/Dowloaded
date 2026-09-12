//! The licence ledger.
//!
//! The Node server keeps all of this in one JSON file that is rewritten in
//! full, 50ms after every change. That works until it doesn't: two writes in
//! the same tick, or a power cut mid-write, and the file is either stale or
//! truncated — and it holds every key ever sold.
//!
//! SQLite keeps the same single-file deployment (one file to back up, one file
//! to copy) and adds the thing the JSON file cannot have: a transaction. A key
//! is issued and its device bound in one commit, or neither happens.
//!
//! The schema mirrors the JSON shapes rather than improving on them, because
//! the two servers run side by side during the port and must agree about what
//! a key *is*. Improvements come after the cutover, not during it.

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug)]
pub struct Counts {
    pub keys: i64,
    pub devices: i64,
    pub events: i64,
    pub plans: i64,
    pub notices: i64,
    pub settings: i64,
    pub usage: i64,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        // WAL so a reader never blocks the writer: the admin panel polls while
        // customers are activating, and neither should wait on the other.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    /// An in-memory ledger, for tests that must not touch a file.
    pub fn open_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock means a previous holder panicked mid-write. The
        // ledger is still consistent — SQLite saw either a whole statement or
        // none — so carrying on is better than refusing every later request.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute_batch(
            r#"
            -- One row per licence key. Column names follow the JSON file's
            -- field names so the two servers describe a key identically.
            CREATE TABLE IF NOT EXISTS keys (
                key            TEXT PRIMARY KEY,
                email          TEXT,
                created_at     INTEGER,
                revoked        INTEGER NOT NULL DEFAULT 0,
                blocked        INTEGER NOT NULL DEFAULT 0,
                blocked_at     INTEGER,
                block_reason   TEXT,
                device_id      TEXT,
                device_name    TEXT,
                activated_at   INTEGER,
                last_heartbeat INTEGER,
                expires_at     INTEGER,
                note           TEXT,
                trial          INTEGER NOT NULL DEFAULT 0,
                plan           TEXT,
                device_limit   INTEGER
            );
            -- Sign-up looks a key up by address, and addresses are compared
            -- without case anywhere else, so the index has to match.
            CREATE INDEX IF NOT EXISTS keys_email ON keys (lower(email));

            -- The hardware ledger: which machines a key runs on, and how many
            -- free downloads each machine has spent. The trial count lives on
            -- the machine, not the key, so a new email cannot reset it.
            CREATE TABLE IF NOT EXISTS devices (
                device_id       TEXT PRIMARY KEY,
                email           TEXT,
                key             TEXT,
                name            TEXT,
                trial_downloads INTEGER NOT NULL DEFAULT 0,
                first_seen      INTEGER,
                bound_at        INTEGER,
                updated_at      INTEGER
            );
            CREATE INDEX IF NOT EXISTS devices_key ON devices (key);
            CREATE INDEX IF NOT EXISTS devices_email ON devices (lower(email));

            CREATE TABLE IF NOT EXISTS events (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                at     INTEGER NOT NULL,
                type   TEXT,
                key    TEXT,
                ip     TEXT,
                detail TEXT
            );
            CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);
            -- An event has no id of its own in the JSON file (it is numbered by
            -- array position, which collides as soon as the log is trimmed), so
            -- its identity is what it says. Without this, importing the same
            -- file twice doubles the audit log.
            CREATE UNIQUE INDEX IF NOT EXISTS events_natural
                ON events (at, ifnull(type,''), ifnull(key,''), ifnull(ip,''), ifnull(detail,''));

            -- The admin panel's knobs. Values are JSON so a boolean stays a
            -- boolean and a number stays a number across both servers.
            CREATE TABLE IF NOT EXISTS settings (
                name  TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plans (
                id        TEXT PRIMARY KEY,
                name      TEXT NOT NULL,
                price     TEXT,
                period    TEXT,
                devices   INTEGER NOT NULL DEFAULT 1,
                features  TEXT,              -- JSON array
                highlight INTEGER NOT NULL DEFAULT 0,
                active    INTEGER NOT NULL DEFAULT 0,
                buy_url   TEXT,
                ord       INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS notices (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL,
                body         TEXT,
                audience     TEXT NOT NULL DEFAULT 'all',
                level        TEXT NOT NULL DEFAULT 'info',
                action_label TEXT,
                action_url   TEXT,
                active       INTEGER NOT NULL DEFAULT 1,
                created_at   INTEGER,
                updated_at   INTEGER
            );

            -- Downloads per key per day. The JSON file keeps only today, and
            -- loses it on a restart; keeping the day as part of the key costs
            -- nothing and leaves a history worth reading later.
            CREATE TABLE IF NOT EXISTS usage (
                key   TEXT NOT NULL,
                day   TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (key, day)
            );
            "#,
        )?;
        Ok(())
    }

    pub fn counts(&self) -> rusqlite::Result<Counts> {
        let conn = self.lock();
        let one = |sql: &str| -> rusqlite::Result<i64> { conn.query_row(sql, [], |r| r.get(0)) };
        Ok(Counts {
            keys: one("SELECT COUNT(*) FROM keys")?,
            devices: one("SELECT COUNT(*) FROM devices")?,
            events: one("SELECT COUNT(*) FROM events")?,
            plans: one("SELECT COUNT(*) FROM plans")?,
            notices: one("SELECT COUNT(*) FROM notices")?,
            settings: one("SELECT COUNT(*) FROM settings")?,
            usage: one("SELECT COUNT(*) FROM usage")?,
        })
    }

    /// A setting as it was stored: JSON, so callers get the type back.
    pub fn setting(&self, name: &str) -> rusqlite::Result<Option<serde_json::Value>> {
        let conn = self.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE name = ?1", [name], |r| r.get(0))
            .optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_setting(&self, name: &str, value: &serde_json::Value) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO settings (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            rusqlite::params![name, value.to_string()],
        )?;
        Ok(())
    }
}
