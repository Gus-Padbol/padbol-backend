import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSedeReleaseInsert} from './sedeReleaseContract.js';

const BASE = {nombre: 'Mostra d Oltremare (ficticia)', pais: 'Italia', ciudad: 'Napoli', timezone: 'Europe/Rome', direccion: 'Via J.F. Kennedy 54'};

test('sede reservable sigue exigiendo los seis campos y validaciones', () => {
  assert.throws(() => buildSedeReleaseInsert({...BASE, tipo_sede: 'reservable'}),
    (e) => e.status === 400 && e.code === 'SEDE_REQUIRED_CONFIGURATION' && e.fields.length > 0);
  const ok = buildSedeReleaseInsert({...BASE, tipo_sede: 'reservable', horario_apertura: '08:00', horario_cierre: '23:00', cantidad_canchas: 2, precio_turno: 1000, telefono: '555'});
  assert.equal(ok.cantidad_canchas, 2);
  assert.equal(ok.precio_por_reserva, 1000);
  assert.equal(ok.whatsapp_contacto, '555');
});

test('sede de torneo se crea sin los cinco campos y los persiste en null', () => {
  const row = buildSedeReleaseInsert({...BASE, tipo_sede: 'torneo'});
  assert.equal(row.tipo_sede, 'torneo');
  assert.equal(row.cantidad_canchas, null);
  assert.equal(row.horario_apertura, null);
  assert.equal(row.horario_cierre, null);
  assert.equal(row.precio_por_reserva, null);
  assert.equal(row.whatsapp_contacto, null);
  assert.equal(row.nombre, BASE.nombre);
  assert.equal(row.ciudad, 'Napoli');
});

test('sede de torneo sin nombre o ciudad se rechaza', () => {
  assert.throws(() => buildSedeReleaseInsert({pais: 'Italia', tipo_sede: 'torneo'}),
    (e) => e.code === 'SEDE_REQUIRED_CONFIGURATION' && e.fields.includes('nombre'));
});
