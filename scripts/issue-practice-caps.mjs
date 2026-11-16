#!/usr/bin/env node
// ROOT-only: issue one capability per board. Writes mode 0600; never log/copy tokens.
import fs from 'node:fs';
import pg from 'pg';
import { issuePracticeControlToken } from '../lib/torneos/nationsPractice.js';
const url = process.env.NATIONS_PRACTICE_PG_URL;
const out = process.env.PRACTICE_CAPS_FILE;
const explicitExpiry = process.env.PRACTICE_CAPS_EXPIRES_AT;
if (!url || !out) { console.error('Set NATIONS_PRACTICE_PG_URL and PRACTICE_CAPS_FILE'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
try {
  const rows = (await pool.query("SELECT id,scoreboard_id FROM nations_practice.matches ORDER BY id")).rows;
  const expiresAt = explicitExpiry || new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt))) { console.error('Invalid PRACTICE_CAPS_EXPIRES_AT'); process.exit(2); }
  const caps = [];
  for (const row of rows) {
    const cap = await issuePracticeControlToken({ pool, eventId: 1, matchId: row.id, expiresAt });
    caps.push({ boardId: row.scoreboard_id, matchId: String(row.id), expiresAt: cap.expiresAt, capability: cap.token });
  }
  fs.writeFileSync(out, JSON.stringify(caps, null, 2), { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log(JSON.stringify({ ok: true, boards: caps.length, fileMode: '0600' }));
} finally { await pool.end(); }
