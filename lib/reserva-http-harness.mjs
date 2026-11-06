// Arnés HTTP del handler REAL de reservas con PGlite y un shim mínimo estilo Supabase.
import express from 'express';
import http from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {createReservaHandler} from './crearReservaHandler.js';

const db = new PGlite();
await db.exec(`
  create schema if not exists auth;
  create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, user_metadata jsonb default '{}'::jsonb);
  create table public.sedes(id bigserial primary key, nombre text not null, pais text not null, ciudad text not null,
    direccion text, tipo_sede text not null default 'reservable',
    cantidad_canchas integer, horario_apertura text, horario_cierre text,
    precio_por_reserva numeric, whatsapp_contacto text);
  create table public.suspensiones_jugador(id bigserial primary key, user_id uuid, suspendido_hasta timestamptz, levantada_at timestamptz, created_at timestamptz default now());
  create table public.partidos_abiertos(id bigserial primary key, sede_id bigint, torneo_id bigint, creador_id uuid,
    fecha date, hora text, cancha text, cupos integer, estado text default 'abierto', created_at timestamptz default now());
  create table public.reservas (
      id bigserial primary key,
      sede text,
      fecha text,
      hora text,
      cancha integer,
      nombre text,
      email text,
      telefono text,
      whatsapp text,
      nivel text,
      precio integer,
      estado text,
      created_at text,
      recordatorio_enviado boolean,
      mp_payment_id text,
      mp_comprobante_url text,
      monto_pagado numeric,
      moneda text,
      user_id uuid,
      duracion_minutos integer,
      tipo text,
      qr_token text,
      checkin_at timestamptz,
      checkin_by text,
      checkin_realizado boolean,
      pago_estado text,
      hora_inicio text,
      hora_fin text,
      cancha_id integer,
      sede_id integer,
      notificacion_post_partido_enviada boolean,
      partido_id bigint,
      deporte text,
      precio_esperado integer,
      pricing_snapshot jsonb,
      stripe_checkout_session_id text,
      stripe_payment_intent_id text,
      payment_provider text,
      mp_preference_id text,
      origen_creacion text
    );
`);

const sqlIdent = (s) => String(s).replace(/"/g, '');
const toSqlValue = (v) => (v === undefined ? null : v);

function builder(table, op, payload) {
  const filters = [];
  let limitN = null;
  let singleMode = false;
  const api = {
    select() { return api; },
    eq(col, val) { filters.push(['eq', col, val]); return api; },
    in(col, vals) { filters.push(['in', col, vals]); return api; },
    order() { return api; },
    limit(n) { limitN = n; return api; },
    maybeSingle() { singleMode = true; return run(true); },
    single() { singleMode = true; return run(false); },
    then(res, rej) { return run(false).then(res, rej); },
  };
  async function run(allowEmpty) {
    if (op === 'insert') {
      const filas = Array.isArray(payload) ? payload : [payload];
      const cols = Object.keys(filas[0] || {});
      if (!cols.length) return {data: null, error: new Error('insert sin columnas')};
      const filasSql = [];
      const params = [];
      for (const fila of filas) {
        const ph = cols.map((c) => { params.push(toSqlValue(fila[c])); return `$${params.length}`; }).join(',');
        filasSql.push(`(${ph})`);
      }
      const sql = `insert into public.${sqlIdent(table)}(${cols.join(',')}) values${filasSql.join(',')} returning *`;
      try {
        const r = await db.query(sql, params);
        return {data: singleMode ? (r.rows[0] || null) : r.rows, rows: r.rows, error: null};
      } catch (e) { console.log('SQLFAIL insert:', sql, JSON.stringify(cols)); return {data: null, error: e}; }
    }
    let params = [];
    const where = filters.map((f) => {
      if (f[0] === 'in') { params.push(f[2]); return `${sqlIdent(f[1])} = ANY($${params.length})`; }
      params.push(f[2]); return `${sqlIdent(f[1])} = $${params.length}`;
    }).join(' and ');
    const sql = `select * from public.${sqlIdent(table)}${where ? ' where ' + where : ''}${limitN ? ' limit ' + limitN : ''}`;
    try {
      const r = await db.query(sql, params);
      if (process.env.SHIM_DEBUG) console.log('SHIM select', table, JSON.stringify(filters), 'rows=', r.rows.length);
      return {data: singleMode ? (r.rows[0] || null) : r.rows, rows: r.rows, error: null};
    } catch (e) { return {data: null, error: e}; }
  }
  return api;
}

const supabaseAdmin = {from: (table) => ({select: () => builder(table, 'select'), insert: (row) => builder(table, 'insert', row)})};
const pgPool = {query: (sql, params) => db.query(sql, params), connect: async () => ({query: (s, p) => db.query(s, p), release() {}})};

const USERS = {
  'Bearer jugador': {id: '11111111-1111-4111-8111-111111111111', email: 'jugador@test.invalid'},
};
const getAuthenticatedUser = async (req) => {
  const u = USERS[req.headers.authorization];
  if (!u) return {user: null, status: 401, error: 'No autorizado'};
  return {user: {...u, user_metadata: {}}, status: 200};
};

const app = express();
app.use(express.json());
app.post('/api/reservas', createReservaHandler({
  getAuthenticatedUser, supabaseAdmin, pgPool,
  computePartidoDeadlineCancel: () => null,
  sendHttpError: (res, err) => res.status(err?.status || 500).json({error: err?.message || 'Error'}),
}));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const post = async (body, token = 'jugador') => {
  const res = await fetch(base + '/api/reservas', {method: 'POST', headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body)});
  return {status: res.status, body: await res.json().catch(() => ({}))};
};

await db.query("insert into public.sedes(id,nombre,pais,ciudad,tipo_sede,cantidad_canchas,horario_apertura,horario_cierre,precio_por_reserva,whatsapp_contacto) values(1,'Sede reservable ficticia','Argentina','La Plata','reservable',2,'08:00','23:00',1000,'555')");
await db.query("insert into public.sedes(id,nombre,pais,ciudad,tipo_sede) values(2,'Sede torneo ficticia','Italia','Napoli','torneo')");
await db.query("insert into auth.users(id,email,email_confirmed_at) values('11111111-1111-4111-8111-111111111111','jugador@test.invalid',now())");

const out = [];
const chk = (n, ok, d) => out.push({n, ok: Boolean(ok), d});
const baseBody = (sedeId) => ({sede_id: sedeId, fecha: '2026-11-21', hora: '10:00', cancha: 'Cancha 1', email: 'jugador@test.invalid', nombre: 'Jugador de prueba', whatsapp: '555'});

const r1 = await post(baseBody(1));
const n1 = await db.query('select count(*)::int n from public.reservas');
chk('reservable normal OK y persiste', [200, 201].includes(r1.status) && n1.rows[0].n === 1, `status=${r1.status} filas=${n1.rows[0].n} ${JSON.stringify(r1.body).slice(0, 100)}`);

const r2 = await post(baseBody(2));
const n2 = await db.query('select count(*)::int n from public.reservas');
chk('sede torneo => 409 sin persistir', r2.status === 409 && n2.rows[0].n === 1, `status=${r2.status} code=${r2.body.code} filas=${n2.rows[0].n}`);

const r3 = await post(baseBody(1), '');
chk('sin sesión => 401', r3.status === 401, `status=${r3.status}`);

const r4 = await post({...baseBody(1), fecha: ''}, 'jugador');
chk('faltan campos => 400', r4.status === 400, `status=${r4.status} ${JSON.stringify(r4.body).slice(0, 80)}`);

server.close();
for (const r of out) console.log(r.ok ? 'PASS' : 'FAIL', '|', r.n, '|', r.d);
const fail = out.filter((r) => !r.ok).length;
console.log('RESUMEN', `${out.length - fail}/${out.length} PASS`, 'FAIL:', fail);
process.exit(fail ? 1 : 0);
