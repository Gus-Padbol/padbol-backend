import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const sql = fs.readFileSync(
  path.resolve('docs/sql/scoreboard_watch_control_migration.sql'),
  'utf8',
);

describe('scoreboard watch atomic migration', () => {
  it('agrega revision y sesiones revocables/expirables', () => {
    assert.match(sql, /add column if not exists revision bigint/i);
    assert.match(sql, /create table if not exists scoreboard_control_sessions/i);
    assert.match(sql, /expires_at timestamptz not null/i);
    assert.match(sql, /revoked_at timestamptz/i);
    assert.match(sql, /pairing_code_hash text unique/i);
    assert.match(sql, /pairing_claimed_at timestamptz/i);
  });

  it('reclama pairing una sola vez bajo lock y recién entonces emite token', () => {
    assert.match(sql, /scoreboard_claim_watch_pairing/i);
    assert.match(sql, /pairing_code_hash = p_pairing_code_hash for update/i);
    assert.match(sql, /pairing_claimed_at is not null/i);
    assert.match(sql, /gen_random_bytes\(32\)/i);
    assert.match(sql, /pairing_claimed_at = now\(\), pairing_code_hash = null/i);
  });

  it('deduplica action_id por sesión dentro de la transacción', () => {
    assert.match(sql, /primary key \(session_id, action_id\)/i);
    assert.match(sql, /for update/i);
    assert.match(sql, /deduplicated[^;]+true/is);
  });

  it('aplica compare-and-swap por expected_revision', () => {
    assert.match(sql, /v_board\.revision <> p_expected_revision/i);
    assert.match(sql, /revision = revision \+ 1/i);
    assert.match(sql, /status','conflict'/i);
  });

  it('restringe el RPC a service_role', () => {
    assert.match(sql, /scoreboard_control_sessions enable row level security/i);
    assert.match(sql, /scoreboard_control_actions enable row level security/i);
    assert.match(sql, /revoke all on scoreboard_control_sessions from anon, authenticated/i);
    assert.match(sql, /revoke all on function scoreboard_apply_control_action/i);
    assert.match(sql, /grant execute[^;]+service_role/i);
  });
});
