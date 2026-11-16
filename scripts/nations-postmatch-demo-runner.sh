#!/bin/sh
set -eu
ROOT="${TMPDIR:-/tmp}/nations-postmatch-ai-demo-$$"
DB=nations_postmatch_ai_demo
PORT="${NATIONS_POSTMATCH_DEMO_PORT:-55439}"
trap 'pg_ctl -D "$ROOT/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT"
initdb -D "$ROOT/data" -A trust >/dev/null
pg_ctl -D "$ROOT/data" -o "-p $PORT -k $ROOT" -l "$ROOT/postgres.log" start >/dev/null
createdb -h "$ROOT" -p "$PORT" "$DB"
export NATIONS_POSTMATCH_PG_URL="postgresql:///$DB?host=$ROOT&port=$PORT"
export NATIONS_POSTMATCH_CACHE="${NATIONS_POSTMATCH_CACHE:-/tmp/nations-postmatch-demo-stub.json}"
export NATIONS_POSTMATCH_CLAIM="${NATIONS_POSTMATCH_CLAIM:-/tmp/nations-postmatch-demo-stub.claim}"
export NATIONS_POSTMATCH_RECEIPT="${NATIONS_POSTMATCH_RECEIPT:-/tmp/nations-postmatch-demo-stub-receipt.json}"
export NATIONS_POSTMATCH_REPORT="${NATIONS_POSTMATCH_REPORT:-/tmp/nations-postmatch-demo-stub-report.html}"
exec node "$(dirname "$0")/nations-postmatch-demo.mjs" "$@"
