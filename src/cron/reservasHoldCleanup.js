const TZ_RESERVA = 'America/Argentina/Buenos_Aires';

export const PRERESERVA_HOLD_TTL_MINUTES = 30;
export const PENDIENTE_HOLD_TTL_MINUTES = 60;

const EXPIRED_HOLDS_SQL = `
WITH expired AS (
  SELECT
    id,
    CASE
      WHEN lower(trim(estado)) = 'prereserva' THEN 'prereserva'
      ELSE 'pendiente'
    END AS hold_type
  FROM reservas
  WHERE lower(trim(COALESCE(pago_estado, 'pendiente'))) = 'pendiente'
    AND lower(trim(COALESCE(pago_estado, ''))) <> 'pagado'
    AND (
      (
        lower(trim(estado)) = 'prereserva'
        AND created_at < now() - ($1::text || ' minutes')::interval
      )
      OR (
        lower(trim(estado)) = 'pendiente'
        AND created_at < now() - ($2::text || ' minutes')::interval
      )
    )
)
UPDATE reservas r
SET estado = 'cancelada',
    pago_estado = 'no_aplica'
FROM expired e
WHERE r.id = e.id
RETURNING r.id, e.hold_type;
`;

const CANCEL_PARTIDOS_ABIERTOS_SQL = `
UPDATE partidos_abiertos
SET estado = 'cancelado'
WHERE reserva_id = ANY($1::bigint[])
  AND lower(trim(estado)) = 'abierto'
RETURNING id;
`;

async function cleanupExpiredReservaHoldsPg(pgPool) {
  const { rows } = await pgPool.query(EXPIRED_HOLDS_SQL, [
    String(PRERESERVA_HOLD_TTL_MINUTES),
    String(PENDIENTE_HOLD_TTL_MINUTES),
  ]);

  const prereservaIds = [];
  const pendienteIds = [];
  for (const row of rows) {
    if (row.hold_type === 'prereserva') prereservaIds.push(row.id);
    else pendienteIds.push(row.id);
  }

  const allIds = rows.map((row) => row.id);
  let partidosCancelados = 0;

  if (allIds.length > 0) {
    const { rows: partidoRows } = await pgPool.query(CANCEL_PARTIDOS_ABIERTOS_SQL, [allIds]);
    partidosCancelados = partidoRows.length;
  }

  return {
    prereserva_canceladas: prereservaIds.length,
    pendiente_canceladas: pendienteIds.length,
    total: rows.length,
    partidos_cancelados: partidosCancelados,
    reserva_ids: allIds,
  };
}

function isExpiredHoldRow(row, nowMs) {
  const estado = String(row?.estado ?? '').toLowerCase();
  const pagoEstado = String(row?.pago_estado ?? 'pendiente').toLowerCase();
  if (pagoEstado === 'pagado') return false;
  if (pagoEstado !== 'pendiente') return false;

  const createdAt = new Date(row.created_at).getTime();
  if (Number.isNaN(createdAt)) return false;

  if (estado === 'prereserva') {
    return createdAt < nowMs - PRERESERVA_HOLD_TTL_MINUTES * 60 * 1000;
  }
  if (estado === 'pendiente') {
    return createdAt < nowMs - PENDIENTE_HOLD_TTL_MINUTES * 60 * 1000;
  }
  return false;
}

async function cleanupExpiredReservaHoldsSupabase(supabaseAdmin) {
  const nowMs = Date.now();
  const cutoffPrereserva = new Date(nowMs - PRERESERVA_HOLD_TTL_MINUTES * 60 * 1000).toISOString();
  const cutoffPendiente = new Date(nowMs - PENDIENTE_HOLD_TTL_MINUTES * 60 * 1000).toISOString();

  const queries = await Promise.all([
    supabaseAdmin
      .from('reservas')
      .select('id, estado, pago_estado, created_at')
      .eq('estado', 'prereserva')
      .eq('pago_estado', 'pendiente')
      .lt('created_at', cutoffPrereserva),
    supabaseAdmin
      .from('reservas')
      .select('id, estado, pago_estado, created_at')
      .eq('estado', 'pendiente')
      .eq('pago_estado', 'pendiente')
      .lt('created_at', cutoffPendiente),
  ]);

  for (const result of queries) {
    if (result.error) throw result.error;
  }

  const byId = new Map();
  for (const row of queries.flatMap((r) => r.data ?? [])) {
    if (isExpiredHoldRow(row, nowMs)) {
      byId.set(row.id, row);
    }
  }

  const expiredRows = [...byId.values()];
  const prereservaIds = expiredRows.filter((r) => r.estado === 'prereserva').map((r) => r.id);
  const pendienteIds = expiredRows.filter((r) => r.estado === 'pendiente').map((r) => r.id);
  const allIds = expiredRows.map((r) => r.id);
  let partidosCancelados = 0;

  for (const id of allIds) {
    const { error: updateErr } = await supabaseAdmin
      .from('reservas')
      .update({ estado: 'cancelada', pago_estado: 'no_aplica' })
      .eq('id', id)
      .in('estado', ['prereserva', 'pendiente'])
      .eq('pago_estado', 'pendiente');

    if (updateErr) throw updateErr;
  }

  if (allIds.length > 0) {
    const { data: partidos, error: partidosErr } = await supabaseAdmin
      .from('partidos_abiertos')
      .update({ estado: 'cancelado' })
      .in('reserva_id', allIds)
      .eq('estado', 'abierto')
      .select('id');

    if (partidosErr) throw partidosErr;
    partidosCancelados = partidos?.length ?? 0;
  }

  return {
    prereserva_canceladas: prereservaIds.length,
    pendiente_canceladas: pendienteIds.length,
    total: allIds.length,
    partidos_cancelados: partidosCancelados,
    reserva_ids: allIds,
  };
}

export async function cleanupExpiredReservaHolds({ supabaseAdmin, pgPool }) {
  if (pgPool) {
    return cleanupExpiredReservaHoldsPg(pgPool);
  }
  if (!supabaseAdmin) {
    throw new Error('supabaseAdmin requerido para limpiar holds vencidos');
  }
  return cleanupExpiredReservaHoldsSupabase(supabaseAdmin);
}

export function initReservasHoldCleanupCron({ supabaseAdmin, pgPool, cron, timezone = TZ_RESERVA }) {
  const run = async () => {
    try {
      const result = await cleanupExpiredReservaHolds({ supabaseAdmin, pgPool });
      if (result.total > 0) {
        console.log(
          `⏰ Cron holds vencidos: ${result.total} reserva(s)`
          + ` (${result.prereserva_canceladas} prereserva, ${result.pendiente_canceladas} pendiente)`
          + ` — ${result.partidos_cancelados} partido(s) abierto(s) cancelado(s)`,
        );
      }
    } catch (err) {
      console.error('❌ Cron holds vencidos - error inesperado:', err.message);
    }
  };

  cron.schedule('*/5 * * * *', run, { timezone });
  run().catch((err) => {
    console.warn('⚠️ Cron holds vencidos (arranque):', err.message);
  });

  console.log('⏰ Cron holds vencidos registrado (cada 5 min)');
}
