export const clockSnapshot = (row, clockRevision = 0) => ({
  clockRevision: Number(clockRevision)||0,
  inicio: row?.cronometro_inicio ? new Date(row.cronometro_inicio).toISOString() : null,
  pausado: row?.cronometro_pausado === true,
  segundos: Number(row?.cronometro_segundos) || 0,
  estado: String(row?.estado || ''),
});
export function clockMismatch(expected, current, trackingClosed = false) {
  if (!expected) return 'CLOCK_SNAPSHOT_MISSING';
  if (Number(expected.clockRevision) !== Number(current.clockRevision)) return 'CLOCK_REVISION_CHANGED';
  if (expected.inicio !== current.inicio) return 'CLOCK_INICIO_CHANGED';
  if (expected.pausado !== current.pausado) return 'CLOCK_PAUSE_CHANGED';
  if (expected.segundos !== current.segundos) return 'CLOCK_SECONDS_CHANGED';
  if (expected.estado !== current.estado) {
    const closedEquivalent = trackingClosed && ['finalizado', 'cerrado', 'closed', 'terminado'].includes(current.estado);
    if (!closedEquivalent) return 'CLOCK_CYCLE_CHANGED';
  }
  return null;
}
