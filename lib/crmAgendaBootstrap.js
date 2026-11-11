// Bootstrap de Agenda programada. Compuerta NUEVA y explicita: apagada por defecto.
import {createLeadAlertsScheduler} from './crmLeadAlertsScheduler.js';

export const AGENDA_FLAG = 'CRM_AGENDA_INTERNAL_REMINDERS_ENABLED';

export function createAgendaBootstrap({
  env = process.env,
  createNotifier = null,
  schedulerFactory = createLeadAlertsScheduler,
  intervalMs = 60_000,
  logger = console,
} = {}) {
  let scheduler = null;
  let notifier = null;
  let enabled = false;
  let ticking = false;
  async function tick() {
    // Evita solapamiento de ticks locales.
    if (ticking || !notifier) return { skipped: true };
    ticking = true;
    try { return await notifier(); } finally { ticking = false; }
  }
  return {
    start() {
      enabled = String(env?.[AGENDA_FLAG] ?? '').toLowerCase() === 'true';
      if (!enabled) return { started: false, reason: 'FLAG_OFF' };
      if (!createNotifier) return { started: false, reason: 'NO_NOTIFIER_FACTORY' };
      notifier = createNotifier();
      scheduler = schedulerFactory({enabled: true, runAgenda: tick, intervalMs, logger});
      const r = scheduler.start();
      return { started: r.started === true, reason: r.reason };
    },
    stop() { return scheduler ? scheduler.stop() : { stopped: false }; },
    get status() { return { enabled, running: Boolean(scheduler?.running), ticking }; },
    tick,
  };
}
