// Domain validation only. A caller must commit these transitions with the
// linked match and court availability in a single transaction.
function transitionError(message) {
  return Object.assign(new Error(message), { status: 409 });
}

export function buildSuspension(partido, now = Date.now()) {
  if (String(partido?.estado || '').trim().toLowerCase() !== 'en_curso') {
    throw transitionError('Solo se puede suspender un partido en curso');
  }
  if (!Number.isFinite(now)) throw new TypeError('Invalid suspension time');
  const start = partido.cronometro_inicio ? Date.parse(partido.cronometro_inicio) : NaN;
  const elapsed = Number.isFinite(start) && !partido.cronometro_pausado
    ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  const accumulated = Number(partido.cronometro_segundos || 0);
  if (!Number.isFinite(accumulated) || accumulated < 0) {
    throw transitionError('El reloj del partido contiene un valor inválido');
  }
  return {
    estado: 'suspendido',
    cronometro_inicio: null,
    cronometro_pausado: true,
    cronometro_segundos: Math.floor(accumulated) + elapsed,
  };
}

export function buildResume(partido, cancha) {
  if (String(partido?.estado || '').trim().toLowerCase() !== 'suspendido') {
    throw transitionError('El partido no está suspendido');
  }
  const label = String(cancha ?? '').trim();
  if (!label) throw Object.assign(new Error('Elegí una cancha'), { status: 400 });
  // The clock stays paused until an explicit start. The court must still be
  // checked and acquired atomically by the database.
  return { estado: 'en_curso', cancha: label, cronometro_inicio: null, cronometro_pausado: true };
}
