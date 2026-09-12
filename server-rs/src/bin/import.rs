//! Moves the Node server's licences into SQLite.
//!
//!   cargo run --bin import -- ../server/data/licenses.json ../server/data/licenses.db
//!
//! It runs against keys people paid for, so it says what it did on both sides
//! of the move and refuses to look successful when it was not. Running it twice
//! is safe: every row is written by id, so a second run overwrites rather than
//! duplicates — which is what makes a rehearsal on a copy of live data useful.
//!
//! The JSON file is never modified. It stays exactly where it is, because it is
//! what the Node server is still serving from and what a rollback returns to.

use std::path::PathBuf;
use velox_license::{db::Db, importer};

fn main() {
    let mut args = std::env::args().skip(1);
    let json = args.next().map(PathBuf::from);
    let sqlite = args.next().map(PathBuf::from);

    let (json, sqlite) = match (json, sqlite) {
        (Some(j), Some(s)) => (j, s),
        _ => {
            eprintln!("usage: import <licenses.json> <licenses.db>");
            std::process::exit(2);
        }
    };

    if !json.exists() {
        eprintln!("no such file: {}", json.display());
        std::process::exit(2);
    }

    let db = match Db::open(&sqlite) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("cannot open {}: {e}", sqlite.display());
            std::process::exit(1);
        }
    };

    let before = db.counts().expect("counting");
    let imported = match importer::import_file(&db, &json) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("import failed, nothing was committed: {e}");
            std::process::exit(1);
        }
    };
    let after = db.counts().expect("counting");

    println!("read from {}", json.display());
    println!("  keys     {}", imported.keys);
    println!("  devices  {}", imported.devices);
    println!("  events   {}", imported.events);
    println!("  settings {}", imported.settings);
    println!("  plans    {}", imported.plans);
    println!("  notices  {}", imported.notices);
    println!("  usage    {}", imported.usage);
    println!();
    println!("now in {}", sqlite.display());
    println!("  keys {} (was {})", after.keys, before.keys);
    println!("  devices {} (was {})", after.devices, before.devices);
    println!("  plans {} · notices {} · settings {} · usage {} · events {}",
        after.plans, after.notices, after.settings, after.usage, after.events);

    // The check that matters: every key in the file is in the ledger. Events
    // are excluded — they are appended, not keyed, so a second run adds more.
    if after.keys < imported.keys as i64 {
        eprintln!("\nSTOP: {} keys were read but only {} are in the database", imported.keys, after.keys);
        std::process::exit(1);
    }
    println!("\nevery key that was read is in the database");
}
