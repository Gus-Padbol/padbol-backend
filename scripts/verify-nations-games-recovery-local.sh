#!/bin/bash
set -euo pipefail
PG=/opt/homebrew/opt/postgresql@17/bin
ROOT=$(mktemp -d /tmp/nations-recovery-real.XXXXXX)
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
"$PG/initdb" -D "$ROOT/data" -A trust -U postgres --no-locale >/dev/null
trap '"$PG/pg_ctl" -D "$ROOT/data" stop -m fast >/dev/null || true' EXIT
"$PG/pg_ctl" -D "$ROOT/data" -l "$ROOT/server.log" -o "-h 127.0.0.1 -p $PORT -k $ROOT" start >/dev/null
"$PG/createdb" -U postgres -h 127.0.0.1 -p "$PORT" marker_recovery_real_test
OWN_GAMES_PG_URL="postgres://postgres@127.0.0.1:$PORT/marker_recovery_real_test" OWN_GAMES_PG_PORT="$PORT" /Users/padbol2022/.nvm/versions/node/v22.23.4/bin/node sql/tests/nations_games_recovery_real_pg_candidate.mjs
echo "Isolated QA cluster stopped at $ROOT"
