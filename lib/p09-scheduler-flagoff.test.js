import assert from 'node:assert/strict';
import test from 'node:test';
import {createLeadAlertsScheduler} from './crmLeadAlertsScheduler.js';

test('scheduler P09: flag off por defecto => no arranca ni crea timer', () => {
  let timers = 0; let runs = 0;
  const s = createLeadAlertsScheduler({runAlerts: async () => { runs += 1; }, runAgenda: async () => { runs += 1; },
    setIntervalImpl: () => { timers += 1; return 1; }, clearIntervalImpl: () => {}});
  const r = s.start();
  assert.equal(r.started, false);
  assert.equal(r.reason, 'FLAG_OFF');
  assert.equal(timers, 0);
  assert.equal(runs, 0);
  assert.equal(s.running, false);
});
