import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function md5UuidToken(value) {
  const token = String(value || '').trim();
  if (!UUID_RE.test(token)) return null;
  // PostgreSQL hashes p_cancelacion_token::text, whose UUID rendering is lowercase.
  return crypto.createHash('md5').update(token.toLowerCase()).digest('hex');
}

function safeHashEqual(expected, received) {
  const left = String(expected || '').trim().toLowerCase();
  const right = String(received || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(left) || !/^[0-9a-f]{32}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function canReadNextGenerationRegistration(row, { user, cancellationToken } = {}) {
  const userEmail = normalizeEmail(user?.email);
  const ownerEmail = normalizeEmail(row?.contacto_email);
  if (userEmail && ownerEmail && userEmail === ownerEmail) return true;

  const receivedHash = md5UuidToken(cancellationToken);
  return receivedHash
    ? safeHashEqual(row?.cancelacion_token_hash, receivedHash)
    : false;
}

export function serializeNextGenerationRegistrationStatus(row) {
  const registrationId = String(row?.id || '');
  const sessionId = String(row?.sesion_id || '');
  const status = {
    inscripcion_id: registrationId,
    registration_id: registrationId,
    session_id: sessionId,
    sesion_id: sessionId,
    estado: row?.estado ?? null,
    posicion_espera: row?.posicion_espera ?? null,
    referencia: registrationId
      ? `NGI-${registrationId.replaceAll('-', '').slice(0, 8).toUpperCase()}`
      : null,
    updated_at: row?.updated_at ?? null,
  };

  // The native client consumes the top-level fields. The nested alias keeps
  // compatibility with administrative/web consumers without exposing PII.
  return { ...status, inscripcion: { ...status } };
}

export function mountNextGenerationStatusRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
}) {
  app.get('/api/next-generation/registrations/status', async (req, res) => {
    try {
      const registrationId = String(req.query.registration_id || '').trim();
      const sessionId = String(req.query.session_id || '').trim();
      if (!UUID_RE.test(registrationId) || !UUID_RE.test(sessionId)) {
        return res.status(400).json({ error: 'registration_id y session_id deben ser UUID válidos' });
      }

      const { data: registration, error } = await supabaseAdmin
        .from('ng_inscripciones')
        .select('id, sesion_id, contacto_email, estado, posicion_espera, cancelacion_token_hash, updated_at')
        .eq('id', registrationId)
        .eq('sesion_id', sessionId)
        .maybeSingle();
      if (error) throw error;
      if (!registration) return res.status(404).json({ error: 'Inscripción no encontrada' });

      const auth = await getAuthenticatedUser(req);
      const cancellationToken = req.get('x-ng-cancellation-token');
      if (!canReadNextGenerationRegistration(registration, {
        user: auth?.user,
        cancellationToken,
      })) {
        return res.status(403).json({ error: 'No autorizado para consultar esta inscripción' });
      }

      res.set('Cache-Control', 'private, no-store');
      return res.json(serializeNextGenerationRegistrationStatus(registration));
    } catch (error) {
      console.error('❌ GET /api/next-generation/registrations/status:', error.message);
      return res.status(500).json({ error: 'No se pudo consultar el estado de la inscripción' });
    }
  });
}
