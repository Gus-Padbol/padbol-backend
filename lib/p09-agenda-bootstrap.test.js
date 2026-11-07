import assert from 'node:assert/strict';
import test from 'node:test';
import {createAgendaBootstrap, AGENDA_FLAG} from './crmAgendaBootstrap.js';
import {readFileSync} from 'node:fs';

function deps({flag, timers}) {
  const calls = {notifierFactory: 0, schedulerFactory: 0, notifierRuns: 0};
  const bootstrap = createAgendaBootstrap({
    env: flag === undefined ? {} : {[AGENDA_FLAG]: flag},
    createNotifier: () => { calls.notifierFactory += 1; return async () => { calls.notifierRuns += 1; return {ok: true}; }; },
    schedulerFactory: (opts) => { calls.schedulerFactory += 1; return {
      start(){ timers.push('start'); return {started: true}; },
      stop(){ timers.push('stop'); return {stopped: true}; },
      get running(){ return timers.includes('start') && !timers.includes('stop'); },
      opts,
    }; },
    intervalMs: 1000,
    logger: {warn(){}},
  });
  return {bootstrap, calls};
}

test('flag ausente => cero timer, cero factory/notifier', () => {
  const timers = []; const {bootstrap, calls} = deps({timers});
  assert.deepEqual(bootstrap.start(), {started: false, reason: 'FLAG_OFF'});
  assert.equal(calls.notifierFactory, 0);
  assert.equal(calls.schedulerFactory, 0);
  assert.equal(timers.length, 0);
  assert.equal(bootstrap.stop().stopped, false);
});

test('flag false explicito => apagado', () => {
  const timers = []; const {bootstrap, calls} = deps({flag: 'false', timers});
  assert.equal(bootstrap.start().started, false);
  assert.equal(calls.schedulerFactory, 0);
});

test('flag true con dependencias ficticias => arranca, tick unico y stop', async () => {
  const timers = []; const {bootstrap, calls} = deps({flag: 'true', timers});
  assert.deepEqual(bootstrap.start(), {started: true, reason: undefined});
  assert.equal(calls.notifierFactory, 1);
  assert.equal(calls.schedulerFactory, 1);
  const [a, b] = await Promise.all([bootstrap.tick(), bootstrap.tick()]);
  assert.equal(calls.notifierRuns, 1, 'tick solapado se evita');
  assert.ok(a?.skipped || b?.skipped);
  assert.deepEqual(bootstrap.stop(), {stopped: true});
  assert.ok(timers.includes('stop'));
});

test('server.js monta Agenda con compuerta nueva y apagada por defecto', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from './lib/crmAgendaBootstrap.js'"));
  assert.match(src, /String\(process\.env\[AGENDA_FLAG\] \|\| ''\)\.toLowerCase\(\) === 'true'/);
  assert.ok(src.includes('createAgendaReminderNotifier({ pool: pgPool, webPush: webPushService })'));
  assert.equal(src.includes('agendaBootstrap.start();'), true);
});
