// Scheduler local de avisos internos. Apagado por defecto: solo arranca con enabled === true.
export function createLeadAlertsScheduler({
  enabled = false, runAlerts = null, runAgenda = null,
  intervalMs = 60_000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  let timer = null;
  async function tick() {
    try { if (runAlerts) await runAlerts(); if (runAgenda) await runAgenda(); }
    catch (error) { logger.warn?.('scheduler P09', error?.message || error); }
  }
  return {
    start() {
      if (enabled !== true) return { started: false, reason: 'FLAG_OFF' };
      if (timer) return { started: false, reason: 'RUNNING' };
      timer = setIntervalImpl(() => { void tick(); }, intervalMs);
      return { started: true };
    },
    stop() { if (timer) { clearIntervalImpl(timer); timer = null; return { stopped: true }; } return { stopped: false }; },
    get running() { return Boolean(timer); },
  };
}
