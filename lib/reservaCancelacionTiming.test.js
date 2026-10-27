import test from 'node:test';
import assert from 'node:assert/strict';
import { horasAnticipacionReserva } from './reservaCancelacionTiming.js';
const row = { fecha:'2026-11-22',hora_inicio:'18:00' };
test('Argentina 24h threshold uses real instant, without timezone-shifted now', () => {
  assert.equal(horasAnticipacionReserva(row,{nowMs:Date.parse('2026-11-21T21:30:00Z')}),23.5);
  assert.equal(horasAnticipacionReserva(row,{nowMs:Date.parse('2026-11-21T20:30:00Z')}),24.5);
});
test('Naples venue cancellation uses Europe/Rome instead of fixed Argentina offset', () => {
  assert.equal(horasAnticipacionReserva(row,{nowMs:Date.parse('2026-11-21T17:00:00Z'),timezone:'Europe/Rome'}),24);
});
test('legacy range hora is still accepted', () => {
  assert.equal(horasAnticipacionReserva({fecha:'2026-11-22',hora:'18:00 - 19:00'},{nowMs:Date.parse('2026-11-21T21:00:00Z')}),24);
});
test('invalid date/time/timezone fails before cancellation', () => {
  for (const r of [{fecha:'2026-02-31',hora:'18:00'}, {fecha:'bad',hora:'18:00'}, {fecha:'2026-11-22',hora:'25:00'}]) assert.throws(()=>horasAnticipacionReserva(r),{status:400});
  assert.throws(()=>horasAnticipacionReserva(row,{timezone:'bad/zone'}),{status:400});
});
