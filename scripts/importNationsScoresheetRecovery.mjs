#!/usr/bin/env node
// Dry-run by default. ROOT may apply only after reviewing the migration and actor.
import fs from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const previewPath = args[args.indexOf('--preview') + 1] || '';
const preview = JSON.parse(fs.readFileSync(previewPath, 'utf8'));
const actor = String(process.env.NATIONS_RECOVERY_ACTOR_ID || '').trim();
const url = String(process.env.NATIONS_RECOVERY_PG_URL || '').trim();
if (!Array.isArray(preview.matches) || preview.matches.length !== 9) throw new Error('Preview must contain exactly 9 matches');
if (!actor) throw new Error('NATIONS_RECOVERY_ACTOR_ID is required');
if (apply && !url) throw new Error('NATIONS_RECOVERY_PG_URL is required for --apply');
if (!apply) {
  for (const m of preview.matches) console.log(JSON.stringify({dry_run: true, partido_id: m.partido_id, sets_a: m.sets_a, sets_b: m.sets_b, historial_sets: m.historial_sets}));
  process.exit(0);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  for (const m of preview.matches) {
    const result = await client.query('SELECT public.recuperar_resultado_equipo_nations($1,$2::jsonb,$3::uuid) AS receipt', [m.partido_id, JSON.stringify({goles_a:m.sets_a,goles_b:m.sets_b,historial_sets:m.historial_sets}), actor]);
    console.log(JSON.stringify({partido_id:m.partido_id, receipt:result.rows[0]?.receipt}));
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
