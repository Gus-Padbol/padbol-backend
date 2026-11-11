import test from 'node:test';
import assert from 'node:assert/strict';
import { mountNationsCountryRankingRoutes } from './nationsCountryRanking.js';

const ISOS = ['AR', 'IT', 'ES', 'FR', 'GB', 'US', 'BR', 'DE', 'PT', 'BE', 'NL', 'CH', 'AT', 'AU', 'UY'];
const teams = Array.from({ length: 15 }, (_, index) => ({ id: 100 + index, torneo_id: 1 }));
const mapping = Object.fromEntries(teams.map((team, index) => [team.id, ISOS[index]]));
const event = {
  id: 1,
  nombre: 'Nations QA',
  estado: 'finalizado',
  deporte: 'padbol',
  modalidad_plantel: 'selecciones',
  fecha_inicio: '2026-01-01',
  fecha_fin: '2026-01-02',
  es_prueba: false,
  plan_nations: { config: { reveal_at: '2020-01-01T00:00:00Z', country_by_team: mapping } },
};
const tables = (over = {}) => ({
  nations_activation_events: { data: [{ torneo_id: 1, roster_publication_approved: true }] },
  torneos: { data: [event] },
  equipos: { data: teams },
  tabla_puntos: { data: [{ torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 300 }] },
  ...over,
});

function fakeDb(source) {
  const calls = [];
  return {
    calls,
    from(table) {
      const result = source[table];
      const query = {
        select(fields) {
          calls.push({ table, fields });
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

async function call(db) {
  const routes = new Map();
  mountNationsCountryRankingRoutes({ get: (path, handler) => routes.set(path, handler) }, { db });
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  await routes.get('/api/nations/country-ranking')({ params: {}, query: {} }, res);
  return res;
}

test('route returns the accumulated country ranking without touching the player contract', async () => {
  const db = fakeDb(tables());
  const res = await call(db);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.items.length, 15);
  assert.equal(res.body.items[0].pais, 'AR');
  assert.equal(res.body.items[0].puntos_total, 300);
  assert.equal(res.body.items[0].torneos_count, 1);
  assert.equal(res.body.items[0].posicion, 1);
  assert(db.calls.every((entry) => !String(entry.fields).includes('jugadores')));
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('jugadores'), false);
  assert.equal(serialized.includes('user_id'), false);
  assert.equal(serialized.includes('email'), false);
});

test('failed or absent authoritative approval cannot be replaced by copied flags', async () => {
  const copied = {
    ...event,
    roster_publication_approved: true,
    plan_nations: { ...event.plan_nations, roster_publication_approved: true },
  };
  for (const approvals of [[], [{ torneo_id: 1, roster_publication_approved: false }]]) {
    const res = await call(fakeDb(tables({
      torneos: { data: [copied] },
      nations_activation_events: { data: approvals },
    })));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.items, []);
  }
});

test('drafts and invalid country plans never leak metadata or partial points', async () => {
  const draft = await call(fakeDb(tables({ torneos: { data: [{ ...event, estado: 'abierto' }] } })));
  assert.equal(draft.statusCode, 200);
  assert.deepEqual(draft.body.items, []);

  const invalid = await call(fakeDb(tables({
    torneos: { data: [{ ...event, plan_nations: { config: { reveal_at: '2020-01-01T00:00:00Z', country_by_team: {} } } }] },
  })));
  assert.equal(invalid.statusCode, 503);
  assert.equal(invalid.body.ok, false);
  assert.equal(invalid.body.code, 'NATIONS_COUNTRY_RANKING_DATA_INVALID');
});

test('QA and embargoed events are hidden even when the request is public', async () => {
  const qa = await call(fakeDb(tables({ torneos: { data: [{ ...event, es_prueba: true }] } })));
  assert.equal(qa.statusCode, 200);
  assert.deepEqual(qa.body.items, []);

  const embargoed = await call(fakeDb(tables({
    nations_activation_events: { data: [{ torneo_id: 1, roster_publication_approved: false }] },
  })));
  assert.equal(embargoed.statusCode, 200);
  assert.deepEqual(embargoed.body.items, []);
});

test('storage failures and incoherent country data fail honestly', async () => {
  const storage = await call(fakeDb(tables({ torneos: { error: { code: 'DB_ERROR' }, data: null } })));
  assert.equal(storage.statusCode, 503);
  assert.equal(storage.body.ok, false);
  assert.equal(storage.body.code, 'NATIONS_COUNTRY_RANKING_UNAVAILABLE');

  const duplicated = { ...mapping, 101: 'AR' };
  const incoherent = await call(fakeDb(tables({
    torneos: { data: [{ ...event, plan_nations: { config: { reveal_at: '2020-01-01T00:00:00Z', country_by_team: duplicated } } }] },
  })));
  assert.equal(incoherent.statusCode, 503);
  assert.equal(incoherent.body.ok, false);
  assert.equal(incoherent.body.code, 'NATIONS_COUNTRY_RANKING_DATA_INVALID');
});
