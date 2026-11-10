import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {createNationsProfileRequestsService} from './nationsProfileRequests.js';

const COUNTRIES = ['RO','ES','PT','QA','IT','DE','FR','BE','AT','EG','AE','MX','SE','UA','DK'];
const actorId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const bodyFor = (i) => ({
  request_id: `req-55-${String(i).padStart(2, '0')}`,
  declared_name: `Synthetic Player ${i}`,
  declared_country: COUNTRIES[(i - 1) % COUNTRIES.length],
  age_status: 'adulto',
  guardian_consent: false,
  profile_consent: true,
});

test('55 actores sintéticos nuevos pueden dejar una solicitud pendiente sin duplicados ni vínculo', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema auth;
      create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz);
      create role anon; create role authenticated; create role service_role;
      create table public.torneos(id bigint primary key);
      create table public.nations_activation_events(torneo_id bigint primary key, slug text unique, enabled boolean not null);
      insert into public.torneos values (57);
      insert into public.nations_activation_events values (57, 'nations-cup-napoli-2026', true);`);
    const migration = await readFile(new URL('../sql/migrations/20261107150000_nations_profile_requests.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    for (let i = 1; i <= 55; i += 1) {
      await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [actorId(i), `synthetic-${i}@example.invalid`]);
    }
    const query = async (sql, params) => {
      const result = await db.query(sql, params);
      return {...result, rowCount: result.rows.length || result.affectedRows || 0};
    };
    const service = createNationsProfileRequestsService({pool: {query, connect: async () => ({query, release() {}})}});
    const results = [];
    for (let i = 1; i <= 55; i += 1) {
      results.push(await service.submit('nations-cup-napoli-2026', {id: actorId(i), email_confirmed_at: '2026-01-01T00:00:00Z'}, bodyFor(i)));
    }
    assert.equal(results.length, 55);
    assert.ok(results.every((result) => result.status === 'pendiente'));
    const rows = (await db.query('select actor_user_id, request_id, status from public.nations_profile_requests order by request_id')).rows;
    assert.equal(rows.length, 55);
    assert.equal(new Set(rows.map((row) => row.actor_user_id)).size, 55);
    assert.equal(new Set(rows.map((row) => row.request_id)).size, 55);
    assert.ok(rows.every((row) => row.status === 'pendiente'));

    const again = await service.submit('nations-cup-napoli-2026', {id: actorId(1), email_confirmed_at: '2026-01-01T00:00:00Z'}, bodyFor(1));
    assert.equal(again.status, 'pendiente');
    assert.equal((await db.query('select count(*)::int n from public.nations_profile_requests')).rows[0].n, 55);
    await assert.rejects(
      service.submit('nations-cup-napoli-2026', {id: actorId(1), email_confirmed_at: '2026-01-01T00:00:00Z'}, {...bodyFor(1), request_id: 'req-55-new-id'}),
      /REQUEST_CONFLICT/,
    );
    assert.equal((await db.query('select count(*)::int n from public.nations_profile_requests')).rows[0].n, 55);
  } finally {
    await db.close();
  }
});
