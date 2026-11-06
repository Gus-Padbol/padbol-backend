import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {esSedeTorneo, errorSedeNoReservable, SEDE_TIPO_TORNEO} from './sedeTipo.js';

const forward = fs.readFileSync(new URL('../sql/migrations/20261106190000_sede_tipo_torneo.sql', import.meta.url), 'utf8');
const rollback = fs.readFileSync(new URL('../sql/migrations/20261106190000_sede_tipo_torneo.rollback.sql', import.meta.url), 'utf8');

const LEGACY = `
  create table public.sedes (
    id bigserial primary key,
    nombre text not null,
    pais text not null,
    ciudad text not null,
    cantidad_canchas integer not null,
    horario_apertura text not null,
    horario_cierre text not null,
    precio_por_reserva numeric not null,
    whatsapp_contacto text not null
  );
  insert into public.sedes(nombre,pais,ciudad,cantidad_canchas,horario_apertura,horario_cierre,precio_por_reserva,whatsapp_contacto)
  values ('Sede historica A','Argentina','La Plata',2,'08:00','23:00',1000,'555-0000'),
         ('Sede historica B','Argentina','CABA',1,'09:00','22:00',2000,'555-1111');
`;

const nueva = async () => { const db = new PGlite(); await db.exec(LEGACY); return db; };

test('guard reconoce sede de torneo y devuelve 409', () => {
  assert.equal(esSedeTorneo(SEDE_TIPO_TORNEO), true);
  assert.equal(esSedeTorneo('reservable'), false);
  assert.equal(esSedeTorneo(null), false);
  const e = errorSedeNoReservable();
  assert.equal(e.status, 409);
  assert.equal(e.code, 'SEDE_NO_RESERVABLE');
});

test('la migración preserva las filas existentes y las deja reservables', async () => {
  const db = await nueva();
  await db.exec(forward);
  const {rows} = await db.query("select nombre,tipo_sede,cantidad_canchas from public.sedes order by id");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.tipo_sede), ['reservable','reservable']);
  assert.deepEqual(rows.map((r) => r.cantidad_canchas), [2,1]);
});

test('reservable incompleta es rechazada por el CHECK', async () => {
  const db = await nueva();
  await db.exec(forward);
  await assert.rejects(
    () => db.query("insert into public.sedes(nombre,pais,ciudad,tipo_sede,horario_apertura,horario_cierre,precio_por_reserva,whatsapp_contacto) values('Sin canchas','Argentina','La Plata','reservable','08:00','23:00',1000,'555')"),
    /sedes_reserva_completa_si_reservable/,
  );
});

test('sede de torneo se crea sin los cinco campos de reserva', async () => {
  const db = await nueva();
  await db.exec(forward);
  await db.query("insert into public.sedes(nombre,pais,ciudad,tipo_sede) values('Mostra d Oltremare (ficticia)','Italia','Napoli','torneo')");
  const {rows} = await db.query("select tipo_sede,cantidad_canchas,precio_por_reserva from public.sedes where tipo_sede='torneo'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cantidad_canchas, null);
  assert.equal(rows[0].precio_por_reserva, null);
});

test('el rollback aborta si existe una sede de torneo (no pierde datos)', async () => {
  const db = await nueva();
  await db.exec(forward);
  await db.query("insert into public.sedes(nombre,pais,ciudad,tipo_sede) values('Torneo ficticio','Italia','Napoli','torneo')");
  // El RAISE aborta la transacción; PGlite informa el bloque abortado.
  await assert.rejects(() => db.exec(rollback), /sedes tipo torneo|aborted/i);
  await db.exec('ROLLBACK;'); // cierra la transacción abortada antes de volver a consultar
  const {rows} = await db.query("select count(*)::int n from public.sedes where tipo_sede='torneo'");
  assert.equal(rows[0].n, 1);
});

test('el rollback funciona cuando no hay sedes de torneo', async () => {
  const db = await nueva();
  await db.exec(forward);
  await db.exec(rollback);
  await assert.rejects(
    () => db.query("insert into public.sedes(nombre,pais,ciudad) values('Sin reserva','Argentina','La Plata')"),
    /null value/,
  );
});
