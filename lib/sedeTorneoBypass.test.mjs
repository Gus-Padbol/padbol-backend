// Bypass reportados por el revisor: sede+sede_id juntos, y checkout/free.
import express from 'express';
import http from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {createReservaHandler} from './crearReservaHandler.js';
import {ensureReservaPendienteParaMpPg} from '../routes/reservaPendienteMp.js';

const db = new PGlite();
await db.exec(`
  create schema if not exists auth;
  create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, user_metadata jsonb default '{}'::jsonb);
  create table public.sedes(id bigserial primary key, nombre text not null, pais text not null, ciudad text not null, tipo_sede text not null default 'reservable',
    direccion text, cantidad_canchas integer, horario_apertura text, horario_cierre text, precio_por_reserva numeric, whatsapp_contacto text);
  create table public.reservas(id bigserial primary key, sede text, sede_id bigint, fecha date, hora text, hora_inicio text, hora_fin text,
    cancha text, cancha_id bigint, nombre text, email text, telefono text, whatsapp text, nivel text, precio numeric, precio_esperado numeric,
    moneda text, pricing_snapshot jsonb, payment_provider text, pago_estado text, estado text, duracion_minutos integer, user_id uuid, origen_creacion text,
    created_at timestamptz default now());
  create table public.suspensiones_jugador(id bigserial primary key, user_id uuid, suspendido_hasta timestamptz, levantada_at timestamptz, created_at timestamptz default now());
  create table public.partidos_abiertos(id bigserial primary key, sede_id bigint, torneo_id bigint, creador_id uuid, fecha date, hora text, cancha text, cupos integer, estado text default 'abierto', created_at timestamptz default now());
`);
await db.exec("insert into public.sedes(id,nombre,pais,ciudad,tipo_sede,cantidad_canchas,horario_apertura,horario_cierre,precio_por_reserva,whatsapp_contacto) values(1,'Reservable ficticia','Argentina','La Plata','reservable',2,'08:00','23:00',1000,'555')");
await db.exec("insert into public.sedes(id,nombre,pais,ciudad,tipo_sede) values(2,'Torneo ficticia','Italia','Napoli','torneo')");

// 1) POST /api/reservas con sede_nombre + sede_id de una sede de torneo
const supabaseAdmin = {from: () => ({select: () => ({eq: () => ({maybeSingle: async () => ({data: {id: 2, nombre: 'Torneo ficticia', tipo_sede: 'torneo'}, error: null})})}), insert: () => ({select: async () => ({data: [{id: 99}], error: null})})})};
const app = express(); app.use(express.json());
app.post('/api/reservas', createReservaHandler({
  getAuthenticatedUser: async () => ({user: {id: '11111111-1111-4111-8111-111111111111', email: 'j@test.invalid', user_metadata: {}}, status: 200}),
  supabaseAdmin,
  pgPool: {query: (s, p) => db.query(s, p), connect: async () => ({query: (s, p) => db.query(s, p), release() {}})},
  computePartidoDeadlineCancel: () => null,
  sendHttpError: (res, err) => res.status(err?.status || 500).json({error: err?.message}),
}));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (body) => {
  const res = await fetch(base + '/api/reservas', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer jugador'}, body: JSON.stringify(body)});
  return {status: res.status, body: await res.json().catch(() => ({}))};
};
const out = [];
const chk = (n, ok, d) => out.push({n, ok: Boolean(ok), d});

const r1 = await post({sede: 'Torneo ficticia', sede_id: 2, fecha: '2026-11-21', hora: '10:00', cancha: 'Cancha 1', email: 'j@test.invalid', nombre: 'Jugador de prueba'});
const n1 = await db.query('select count(*)::int n from public.reservas');
chk('sede+sede_id juntos NO evaden el guard', r1.status === 409 && n1.rows[0].n === 0, `status=${r1.status} code=${r1.body.code} filas=${n1.rows[0].n}`);

// 2) checkout/free: ensureReservaPendienteParaMpPg sobre sede de torneo
let checkoutErr = null;
try {
  await ensureReservaPendienteParaMpPg({query: (s, p) => db.query(s, p), connect: async () => ({query: (s, p) => db.query(s, p), release() {}})}, {
    sede: 'Torneo ficticia', sede_id: 2, fecha: '2026-11-21', hora: '10:00', cancha: 'Cancha 1', email: 'j@test.invalid', nombre: 'Jugador de prueba', precio: 1000,
  }, {authUser: {id: '11111111-1111-4111-8111-111111111111', email: 'j@test.invalid'}});
} catch (e) { checkoutErr = e; }
const n2 = await db.query('select count(*)::int n from public.reservas');
chk('checkout/free rechaza sede de torneo', checkoutErr?.status === 409 && n2.rows[0].n === 0, `status=${checkoutErr?.status} code=${checkoutErr?.code} filas=${n2.rows[0].n}`);

server.close();
for (const r of out) console.log(r.ok ? 'PASS' : 'FAIL', '|', r.n, '|', r.d);
const fail = out.filter((r) => !r.ok).length;
console.log('RESUMEN', `${out.length - fail}/${out.length} PASS`, 'FAIL:', fail);
process.exit(fail ? 1 : 0);
