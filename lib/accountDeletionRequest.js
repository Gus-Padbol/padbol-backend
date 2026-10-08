export const ACCOUNT_DELETION_CONFIRMATION = 'ELIMINAR';
export const ACTIVE_ACCOUNT_DELETION_STATUSES = ['solicitada', 'en_proceso', 'retenida'];

const ALLOWED_SOURCES = new Set(['native', 'web']);

export function parseAccountDeletionRequestBody(body = {}) {
  const confirmation = String(body?.confirmation || '').trim();
  if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    return {
      ok: false,
      status: 400,
      code: 'explicit_confirmation_required',
      error: 'Escribí ELIMINAR para confirmar la solicitud.',
    };
  }

  const sourceCandidate = String(body?.source || '').trim().toLowerCase();
  const source = ALLOWED_SOURCES.has(sourceCandidate) ? sourceCandidate : 'unknown';
  const appVersion = String(body?.app_version || '').trim().slice(0, 40);

  return {
    ok: true,
    source,
    evidence: {
      requested_via: source === 'unknown' ? 'authenticated_backend' : `authenticated_${source}`,
      source,
      ...(appVersion ? { app_version: appVersion } : {}),
    },
  };
}

export function buildAccountDeletionAcceptedResponse(request, { idempotent = false } = {}) {
  const row = request && typeof request === 'object' ? request : {};
  return {
    ok: true,
    status: 'pending',
    requested_at: row.solicitado_at || null,
    request_id: row.id ?? null,
    next_step: 'pending_retention_review',
    idempotent,
    message: idempotent
      ? 'Ya existe una solicitud de eliminación activa. No generamos un pedido duplicado.'
      : 'Registramos tu solicitud. La cuenta y los datos se revisarán según los plazos y retenciones legales aplicables.',
  };
}
