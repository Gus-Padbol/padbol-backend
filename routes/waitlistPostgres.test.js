import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readWaitlistForSede } from './waitlistRead.js';
test('PostgreSQL UUID and bigint cursors preserve venue scope across limited pages', async () => {
const pg = new PGlite();
await pg.exec(`CREATE TABLE numeric_wait (id bigint primary key, sede_id integer, user_id uuid, deporte text, created_at timestamptz);
CREATE TABLE uuid_wait (id uuid primary key, sede_id integer, user_id uuid, deporte text, created_at timestamptz);
INSERT INTO numeric_wait SELECT i, 7, '00000000-0000-0000-0000-000000000001', 'padbol', now() FROM generate_series(1,5) i;
INSERT INTO uuid_wait SELECT ('00000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid, 7, '00000000-0000-0000-0000-000000000001', 'padbol', now() FROM generate_series(1,5) i;
INSERT INTO numeric_wait VALUES (6,8,'00000000-0000-0000-0000-000000000001','padbol',now());
INSERT INTO uuid_wait VALUES ('00000000-0000-0000-0000-000000000006',8,'00000000-0000-0000-0000-000000000001','padbol',now());`);
const db={from(table){const clauses=[],args=[];let ord,limit;const q={select(){return q},eq(k,v){args.push(v);clauses.push(`${k} = $${args.length}`);return q},gt(k,v){args.push(v);clauses.push(`${k} > $${args.length}`);return q},order(k){ord=k;return q},limit(n){limit=Math.min(n,2);return q},then(resolve,reject){return pg.query(`SELECT id, sede_id, user_id, deporte, created_at FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY ${ord} LIMIT ${limit}`,args).then(r=>({data:r.rows,error:null})).then(resolve,reject)}};return q}};
for (const table of ['numeric_wait','uuid_wait']) {const rows=await readWaitlistForSede(db,table,7);assert.equal(rows.length,5);assert.ok(rows.every(r=>r.sede_id===7));console.log(`${table}: 5 filas, límite simulado 2, sede aislada`)}
await pg.close();
});
