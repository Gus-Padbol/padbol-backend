import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedSuspendedBookings } from './verifiedSuspendedBookings.js';
test('only verified IDs in the queried suspended set are released', async () => {
  const rows = [{ id: 1, estado: 'suspendida' }, { id: 2, estado: 'suspendida' }, { id: 3, estado: 'confirmada' }];
  const db = { rpc: async (name, input) => {
    assert.equal(name, 'scoreboard_verified_suspended_bookings_candidate');
    assert.deepEqual(input.p_ids, [1, 2]);
    return { data: [{ booking_id: 1 }, { booking_id: 3 }] };
  } };
  assert.deepEqual([...await verifiedSuspendedBookings(db, rows)], ['1']);
  assert.deepEqual([...await verifiedSuspendedBookings({ rpc: async () => ({ error: new Error('unavailable') }) }, rows)], []);
});
