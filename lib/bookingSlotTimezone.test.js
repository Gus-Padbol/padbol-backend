import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSlotInicio } from '../src/pricing/slotInicio.js';
test('venue local time is resolved with its IANA zone and seasonal offset',()=>{
 assert.equal(normalizeSlotInicio('2026-07-10T18:00:00','America/Argentina/Buenos_Aires'),'2026-07-10T21:00:00.000Z');
 assert.equal(normalizeSlotInicio('2026-07-10T18:00:00','America/New_York'),'2026-07-10T22:00:00.000Z');
 assert.equal(normalizeSlotInicio('2026-12-10T18:00:00','America/New_York'),'2026-12-10T23:00:00.000Z');
});
test('nonexistent and repeated local times are rejected, explicit offsets are accepted',()=>{
 for(const value of ['2026-03-08T02:30:00','2026-11-01T01:30:00']) assert.throws(()=>normalizeSlotInicio(value,'America/New_York'),{code:'SLOT_LOCAL_INVALID'});
 assert.equal(normalizeSlotInicio('2026-11-01T01:30:00-04:00','America/New_York'),'2026-11-01T05:30:00.000Z');
});
