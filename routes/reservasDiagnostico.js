import {
  reservaHoraInicioFromRow,
  sqlReservaHoraInicio,
  sqlReservaSedeMatch,
} from '../utils/reservasColumns.js';

const SEDE_DIAGNOSTICO_ID = 1;
const DIAGNOSTICO_LIMIT = 50;

function pgUnavailable(res) {
  return res.status(503).json({ error: 'DATABASE_URL no configurada — diagnóstico de reservas no disponible' });
}

async function resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails }) {
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }
  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  return {
    rol: String(row?.role || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

function isAdminClubOrSuper(role) {
  return role.rol === 'super_admin' || role.rol === 'admin_club';
}

function mapReservaDiagnosticoRow(row) {
  return {
    id: row.id,
    fecha: row.fecha ?? null,
    hora: row.hora ?? null,
    hora_inicio: reservaHoraInicioFromRow(row),
    hora_fin: row.hora_fin ?? null,
    estado: row.estado ?? null,
    monto: row.monto ?? row.monto_pagado ?? row.precio ?? null,
    user_id: row.user_id ?? null,
    created_at: row.created_at ?? null,
    sede: row.sede ?? null,
    sede_id: row.sede_id ?? null,
    cancha_id: row.cancha_id ?? null,
    duracion_minutos: row.duracion_minutos ?? null,
  };
}

async function fetchReservasDiagnosticoPg(pgPool, sedeId, sedeNombre) {
  const horaInicioExpr = sqlReservaHoraInicio('');
  const sedeExpr = sqlReservaSedeMatch('', '$1', '$2');

  const { rows } = await pgPool.query(
    `SELECT *,
            ${horaInicioExpr} AS hora_inicio_resuelta
     FROM reservas
     WHERE ${sedeExpr}
     ORDER BY created_at DESC NULLS LAST
     LIMIT $3`,
    [sedeId, sedeNombre, DIAGNOSTICO_LIMIT],
  );

  return rows.map((row) => ({
    ...row,
    hora_inicio: row.hora_inicio_resuelta ?? row.hora_inicio,
  }));
}

export function mountReservasDiagnosticoRoutes(app, {
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.get('/api/admin/reservas-diagnostico', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      if (!isAdminClubOrSuper(role)) {
        return res.status(403).json({ error: 'No tenés permiso para consultar diagnóstico de reservas' });
      }

      const { rows: sedeRows } = await pgPool.query(
        'SELECT id, nombre FROM sedes WHERE id = $1 LIMIT 1',
        [SEDE_DIAGNOSTICO_ID],
      );
      const sedeNombre = sedeRows[0]?.nombre ?? 'La Meca';

      const rows = await fetchReservasDiagnosticoPg(pgPool, SEDE_DIAGNOSTICO_ID, sedeNombre);

      return res.json({
        sede_id: SEDE_DIAGNOSTICO_ID,
        sede_nombre: sedeNombre,
        count: rows.length,
        reservas: rows.map(mapReservaDiagnosticoRow),
      });
    } catch (err) {
      console.error('❌ GET /api/admin/reservas-diagnostico:', err.message);
      return res.status(500).json({ error: err.message || 'Error al consultar diagnóstico de reservas' });
    }
  });
}
