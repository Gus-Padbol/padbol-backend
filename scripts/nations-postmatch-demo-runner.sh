#!/bin/sh
set -eu
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nations-postmatch-ai-demo.XXXXXX")"
chmod 700 "$ROOT"
DB=nations_postmatch_ai_demo
PORT="${NATIONS_POSTMATCH_DEMO_PORT:-55439}"
cleanup(){ pg_ctl -D "$ROOT/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "$ROOT"; }
trap cleanup EXIT INT TERM
initdb -D "$ROOT/data" --auth-local=trust --auth-host=reject >/dev/null
pg_ctl -D "$ROOT/data" -o "-p $PORT -k $ROOT -h ''" -l "$ROOT/postgres.log" start >/dev/null
createdb -h "$ROOT" -p "$PORT" "$DB"
export NATIONS_POSTMATCH_PG_URL="postgresql:///$DB?host=$ROOT&port=$PORT"
node "$(dirname "$0")/nations-postmatch-demo.mjs" "$@"
STATUS=$?
cleanup
trap - EXIT INT TERM
exit "$STATUS"
