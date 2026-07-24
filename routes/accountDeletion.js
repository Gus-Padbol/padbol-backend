export const ACCOUNT_DELETION_CONFIRMATION = 'ELIMINAR';

export function isAccountDeletionConfirmationValid(value) {
  return String(value ?? '').trim().toUpperCase() === ACCOUNT_DELETION_CONFIRMATION;
}

function normalizeDeletionSource(value) {
  const source = String(value ?? '').trim().toLowerCase();
  return ['native', 'web'].includes(source) ? source : 'native';
}

function isMissingDeletionTableError(error) {
  return error?.code === '42P01'
    || /account_deletion_requests/i.test(String(error?.message ?? ''));
}

export function mountAccountDeletionRoutes(router, {
  supabaseAdmin,
  getAuthenticatedUser,
} = {}) {
  router.post('/eliminacion-cuenta', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      if (!isAccountDeletionConfirmationValid(req.body?.confirmation)) {
        return res.status(400).json({
          error: `Escribí ${ACCOUNT_DELETION_CONFIRMATION} para confirmar la solicitud`,
          code: 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
        });
      }

      const requestedAt = new Date().toISOString();
      const payload = {
        user_id: user.id,
        email: String(user.email ?? '').trim().toLowerCase() || null,
        source: normalizeDeletionSource(req.body?.source),
        status: 'pending',
        requested_at: requestedAt,
        completed_at: null,
      };

      const { data, error } = await supabaseAdmin
        .from('account_deletion_requests')
        .upsert(payload, { onConflict: 'user_id' })
        .select('status, requested_at')
        .single();

      if (error) {
        if (isMissingDeletionTableError(error)) {
          return res.status(503).json({
            error: 'La eliminación de cuenta todavía no está habilitada en el servidor',
            code: 'ACCOUNT_DELETION_NOT_CONFIGURED',
          });
        }
        throw error;
      }

      return res.status(202).json({
        ok: true,
        status: data?.status ?? 'pending',
        requested_at: data?.requested_at ?? requestedAt,
        message:
          'Recibimos tu solicitud. Eliminaremos o anonimizaremos los datos asociados, salvo los que debamos conservar por obligación legal.',
      });
    } catch (error) {
      console.error('❌ Error POST /api/usuarios/eliminacion-cuenta:', error?.message || error);
      return res.status(500).json({
        error: 'No pudimos registrar la solicitud de eliminación',
        code: 'ACCOUNT_DELETION_REQUEST_FAILED',
      });
    }
  });
}
