#!/usr/bin/env bash
#
# Move the licence server from Node to Rust.
#
#   sudo bash /opt/velox/deploy/cutover-to-rust.sh
#
# nginx is not touched: it proxies downloader.prolanka.online to 127.0.0.1:4010
# and the Rust server takes that port over. So the cutover is a process swap, and
# rolling back is the same swap in reverse — no config edit, no reload, nothing
# that can go wrong while customers are mid-download.
#
# What it does, in order:
#
#   1. copies the ledger somewhere safe
#   2. stops the Node server        (downtime starts — a few seconds)
#   3. imports the JSON ledger into SQLite
#   4. starts the Rust server on the same port
#   5. checks it is answering, and answering the same
#   6. puts the Node server back if any of that failed
#
# The JSON ledger is never modified. It stays exactly where it is, which is what
# makes a rollback cheap: deploy/rollback-to-node.sh writes today's data back out
# and starts Node again.

set -uo pipefail

VELOX=${VELOX:-/opt/velox}
DATA=$VELOX/server/data
RUST=$VELOX/server-rs/target/release/velox-license
IMPORT=$VELOX/server-rs/target/release/import
PORT=${PORT:-4010}
STAMP=$(date +%Y%m%d-%H%M%S)
SAFE=/root/velox-cutover-$STAMP

say() { printf '\n%s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

say "1. checking everything is in place"
[ -x "$RUST" ]   || die "no Rust server at $RUST — build it: cd $VELOX/server-rs && cargo build --release"
[ -x "$IMPORT" ] || die "no importer at $IMPORT — the release build makes both"
[ -f "$DATA/licenses.json" ] || die "no ledger at $DATA/licenses.json"
command -v pm2 >/dev/null || die "pm2 is not on PATH"
pm2 describe velox-license >/dev/null 2>&1 || die "pm2 does not know velox-license — is this the right machine?"

# Anything already holding the port would make the Rust server fail to bind, and
# a half-done cutover is the worst outcome.
if pm2 describe velox-license-rs >/dev/null 2>&1; then
  status=$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(x=>x.name==="velox-license-rs");console.log(a?a.pm2_env.status:"missing")})')
  [ "$status" = "online" ] && die "velox-license-rs is already running — nothing to cut over"
fi

# What the Node server is serving right now, to compare against afterwards.
before_plans=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).plans||[]).length)}catch{console.log("?")}})')
before_keys=$(node -e "const s=require('$DATA/licenses.json');console.log(Object.keys(s.keys||{}).length)")
echo "   the shop is serving $before_plans published plan(s) and holds $before_keys key(s)"

say "2. copying the ledger to $SAFE"
mkdir -p "$SAFE"
cp "$DATA/licenses.json" "$SAFE/licenses.json"
[ -f "$DATA/.jwt-secret" ] && cp "$DATA/.jwt-secret" "$SAFE/.jwt-secret"
echo "   done — this is what a rollback returns to if everything else fails"

# ------------------------------------------------------------- the swap

say "3. stopping the Node server (downtime starts)"
pm2 stop velox-license >/dev/null || die "could not stop velox-license"

restore_node() {
  printf '\n   putting the Node server back\n'
  pm2 stop velox-license-rs >/dev/null 2>&1
  pm2 delete velox-license-rs >/dev/null 2>&1
  pm2 start velox-license >/dev/null 2>&1
  for _ in $(seq 1 40); do
    curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && { echo "   the Node server is answering again"; return 0; }
    sleep 0.5
  done
  echo "   THE NODE SERVER IS NOT ANSWERING — run: pm2 start velox-license && pm2 logs velox-license"
}

say "4. importing the ledger into SQLite"
if ! "$IMPORT" "$DATA/licenses.json" "$DATA/licenses.db"; then
  restore_node
  die "the import failed — nothing was changed except that the ledger is still JSON"
fi

say "5. starting the Rust server on port $PORT"
pm2 start "$VELOX/deploy/ecosystem.config.js" --only velox-license-rs >/dev/null 2>&1 \
  || { restore_node; die "pm2 could not start velox-license-rs"; }

say "6. checking it is answering"
up=no
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then up=yes; break; fi
  sleep 0.5
done
[ "$up" = yes ] || { pm2 logs velox-license-rs --lines 20 --nostream; restore_node; die "the Rust server did not come up"; }

after_plans=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).plans||[]).length)}catch{console.log("?")}})')
[ "$after_plans" = "$before_plans" ] \
  || { restore_node; die "it is serving $after_plans plan(s) where the shop had $before_plans — the website would change"; }

# Through nginx, as a customer arrives: the app talks to https://, not the port.
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' --resolve downloader.prolanka.online:443:127.0.0.1 https://downloader.prolanka.online/healthz 2>/dev/null || echo 000)
case "$code" in
  200) echo "   the public address answers too" ;;
  000) echo "   (could not check the public address from here — check it by hand)" ;;
  *)   restore_node; die "the public address answered $code" ;;
esac

login=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login")
[ "$login" = 200 ] || { restore_node; die "the admin sign-in page answered $login"; }

say "7. saving the process list"
pm2 save >/dev/null 2>&1

cat <<DONE

the licence server is Rust now
  ledger:   $DATA/licenses.db   (the JSON file is untouched, at $DATA/licenses.json)
  backup:   $SAFE
  plans:    $after_plans published, unchanged
  logs:     pm2 logs velox-license-rs

to go back:
  sudo bash $VELOX/deploy/rollback-to-node.sh

Watch it for a few minutes: an app checks in on its heartbeat, so the audit log
in the panel is where you will see customers arriving on the new server.
DONE
