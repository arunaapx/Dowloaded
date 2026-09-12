#!/usr/bin/env bash
#
# Put the Node licence server back.
#
#   sudo bash /opt/velox/deploy/rollback-to-node.sh
#
# The reverse of cutover-to-rust.sh, and it keeps what happened in between: the
# SQLite ledger is written back out as the JSON file the Node server reads, so
# keys sold, machines bound and settings changed while Rust was serving all come
# back. Without that step a rollback would quietly return the shop to the moment
# of the cutover.
#
# nginx is not touched. This is a process swap on one port.

set -uo pipefail

VELOX=${VELOX:-/opt/velox}
DATA=$VELOX/server/data
EXPORT=$VELOX/server-rs/target/release/export
PORT=${PORT:-4010}
STAMP=$(date +%Y%m%d-%H%M%S)
SAFE=/root/velox-rollback-$STAMP

say() { printf '\n%s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

say "1. checking everything is in place"
[ -x "$EXPORT" ] || die "no exporter at $EXPORT — build it: cd $VELOX/server-rs && cargo build --release"
[ -f "$DATA/licenses.db" ] || die "no SQLite ledger at $DATA/licenses.db — was the cutover ever done?"
command -v pm2 >/dev/null || die "pm2 is not on PATH"

mkdir -p "$SAFE"
cp "$DATA/licenses.db" "$SAFE/licenses.db" 2>/dev/null
cp "$DATA/licenses.json" "$SAFE/licenses.json-before-rollback" 2>/dev/null
echo "   copies in $SAFE"

say "2. stopping the Rust server (downtime starts)"
pm2 stop velox-license-rs >/dev/null 2>&1

say "3. writing the ledger back out as JSON"
if ! "$EXPORT" "$DATA/licenses.db" "$DATA/licenses.json"; then
  pm2 start velox-license-rs >/dev/null 2>&1
  die "the export failed — the Rust server has been started again so the shop keeps working"
fi

say "4. starting the Node server"
pm2 start velox-license >/dev/null 2>&1 || die "pm2 could not start velox-license"

say "5. checking it is answering"
up=no
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then up=yes; break; fi
  sleep 0.5
done
if [ "$up" != yes ]; then
  pm2 logs velox-license --lines 20 --nostream
  die "the Node server did not come up — the JSON ledger is in place, so: pm2 start velox-license"
fi

keys=$(node -e "const s=require('$DATA/licenses.json');console.log(Object.keys(s.keys||{}).length)")
plans=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).plans||[]).length)}catch{console.log("?")}})')

pm2 delete velox-license-rs >/dev/null 2>&1
pm2 save >/dev/null 2>&1

cat <<DONE

the licence server is Node again
  ledger:  $DATA/licenses.json   ($keys key(s), $plans published plan(s))
  copies:  $SAFE
  logs:    pm2 logs velox-license

The SQLite file is left where it is. Nothing reads it now, and it is the record
of what happened while Rust was serving.
DONE
