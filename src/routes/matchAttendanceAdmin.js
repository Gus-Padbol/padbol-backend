import { requireAdminUser } from '../../lib/authAccess.js';
import {
  adminForceCloseAttendanceCollection,
  adminOverrideParticipantAttendance,
  adminReprocessAttendanceRewards,
  getAdminMatchAttendanceDetail,
  parseAdminForceCloseBody,
  parseAdminParticipantOverrideBody,
  userCanManageMatchAttendance,
} from '../matches/matchAttendanceAdminService.js';
import { getMatchAttendanceState } from '../matches/matchAttendanceService.js';

function parsePartidoId(raw) {
  const id = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function sendRouteError(res, err, fallbackMessage) {
  const status = err.status || 500;
  return res.status(status).json({ error: err.message || fallbackMessage });
}

function mapAdminServiceError(result) {
  const reasonMessages = {
    partido_no_encontrado: 'Partido no encontrado',
    torneo_out_of_scope: 'Confirmación de asistencia no aplica a torneos',
    partido_cancelado: 'El partido está cancelado',
    schema_missing: 'Confirmación de asistencia no disponible',
    credited_locked: 'La ventana ya fue acreditada y no admite cambios',
    participant_not_found: 'El participante no pertenece a este partido',
    invalid_status: 'status inválido; use admin_validated o excluded',
    invalid_action: 'action inválida; use ready o blocked',
    reason_required: 'reason es obligatorio',
    no_eligible_participants: 'No hay participantes elegibles para cerrar como ready',
    not_ready: 'La ventana debe estar en estado ready para reprocesar',
    invalid_match_id: 'ID de partido inválido',
    invalid_user_id: 'userId inválido',
    concurrent_update_conflict: 'Conflicto de actualización concurrente',
  };

  return reasonMessages[result.reason] ?? result.reason ?? 'invalid_request';
}

async function requireMatchAttendanceAdminAccess(req, res, partidoId, adminDeps) {
  const auth = await requireAdminUser(req, res, adminDeps);
  if (!auth) return null;

  const state = await getMatchAttendanceState(adminDeps.supabaseAdmin, partidoId);
  if (!state.ok) {
    res.status(404).json({ error: 'Partido no encontrado' });
    return null;
  }

  const canManage = await userCanManageMatchAttendance(auth.user, state.partido, {
    fetchUserRoleRowForAuthUser: adminDeps.fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails: adminDeps.legacySuperAdminEmails,
  });

  if (!canManage) {
    res.status(403).json({ error: 'No tenés permiso para gestionar la asistencia de este partido' });
    return null;
  }

  return { ...auth, state };
}

export function mountMatchAttendanceAdminRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const adminDeps = {
    supabaseAdmin,
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  app.get('/api/admin/partidos/:id/asistencia', async (req, res) => {
    try {
      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const auth = await requireMatchAttendanceAdminAccess(req, res, partidoId, adminDeps);
      if (!auth) return;

      const result = await getAdminMatchAttendanceDetail(supabaseAdmin, partidoId);
      if (!result.ok) {
        return res.status(result.httpStatus ?? 400).json({ error: mapAdminServiceError(result) });
      }

      return res.json(result);
    } catch (err) {
      console.error('❌ GET /api/admin/partidos/:id/asistencia:', err.message);
      return sendRouteError(res, err, 'Error al consultar asistencia admin');
    }
  });

  app.post('/api/admin/partidos/:id/asistencia/participantes/:userId', async (req, res) => {
    try {
      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const auth = await requireMatchAttendanceAdminAccess(req, res, partidoId, adminDeps);
      if (!auth) return;

      const parsed = parseAdminParticipantOverrideBody(req.body ?? {});
      if (!parsed.ok) {
        return res.status(400).json({ error: mapAdminServiceError(parsed) });
      }

      const result = await adminOverrideParticipantAttendance(
        supabaseAdmin,
        partidoId,
        req.params.userId,
        {
          status: parsed.status,
          reason: parsed.reason,
          actor: {
            user_id: auth.user.id,
            role: auth.role?.rol ?? null,
          },
        },
      );

      if (!result.ok) {
        return res.status(result.httpStatus ?? 400).json({ error: mapAdminServiceError(result) });
      }

      return res.json(result);
    } catch (err) {
      console.error('❌ POST /api/admin/partidos/:id/asistencia/participantes/:userId:', err.message);
      return sendRouteError(res, err, 'Error al aplicar override de asistencia');
    }
  });

  app.post('/api/admin/partidos/:id/asistencia/cerrar', async (req, res) => {
    try {
      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const auth = await requireMatchAttendanceAdminAccess(req, res, partidoId, adminDeps);
      if (!auth) return;

      const parsed = parseAdminForceCloseBody(req.body ?? {});
      if (!parsed.ok) {
        return res.status(400).json({ error: mapAdminServiceError(parsed) });
      }

      const result = await adminForceCloseAttendanceCollection(supabaseAdmin, partidoId, {
        action: parsed.action,
        reason: parsed.reason,
        actor: {
          user_id: auth.user.id,
          role: auth.role?.rol ?? null,
        },
      });

      if (!result.ok) {
        return res.status(result.httpStatus ?? 400).json({ error: mapAdminServiceError(result) });
      }

      return res.json(result);
    } catch (err) {
      console.error('❌ POST /api/admin/partidos/:id/asistencia/cerrar:', err.message);
      return sendRouteError(res, err, 'Error al cerrar ventana de asistencia');
    }
  });

  app.post('/api/admin/partidos/:id/asistencia/reprocesar', async (req, res) => {
    try {
      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const auth = await requireMatchAttendanceAdminAccess(req, res, partidoId, adminDeps);
      if (!auth) return;

      const result = await adminReprocessAttendanceRewards(supabaseAdmin, partidoId, {
        actor: {
          user_id: auth.user.id,
          role: auth.role?.rol ?? null,
        },
      });

      if (!result.ok) {
        return res.status(result.httpStatus ?? 400).json({ error: mapAdminServiceError(result) });
      }

      return res.json(result);
    } catch (err) {
      console.error('❌ POST /api/admin/partidos/:id/asistencia/reprocesar:', err.message);
      return sendRouteError(res, err, 'Error al reprocesar recompensas de asistencia');
    }
  });
}
