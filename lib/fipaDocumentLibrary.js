import crypto from 'node:crypto';

export const FIPA_DOCUMENT_BUCKET = 'fipa-secure-documents';
export const FIPA_SIGNED_URL_TTL_SECONDS = 60;
export const FIPA_DOWNLOAD_LIMIT = 10;
export const FIPA_DOWNLOAD_WINDOW_MS = 5 * 60 * 1000;

const VERIFIED_MEMBER_ORIGINS = new Set(['manual', 'membresia', 'importacion']);
export const FIPA_LIBRARY_PURPOSES = new Set([
  'aprender_jugar',
  'jugador',
  'entrenador_arbitro',
  'club_sede',
  'organizar_competencia',
  'investigacion_prensa',
  'evaluar_proyecto',
  'otro',
]);
const FIPA_PROFILE_ANSWERS = new Set(['yes', 'no', 'prefer_not']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_TEXT_LIMITS = Object.freeze({
  club_name: 180,
  country: 120,
  city: 120,
  address: 500,
});

function cleanText(value, maxLength) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, maxLength) : null;
}

function normalizedComparable(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function positiveIntegerOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function isOfficialFipaVenue(venue) {
  return Boolean(
    venue
      && venue.licencia_activa === true
      && String(venue.numero_licencia ?? '').trim(),
  );
}

export function isVerifiedFipaMembershipOrigin(origin) {
  return VERIFIED_MEMBER_ORIGINS.has(String(origin || ''));
}

export function isActiveFipaGrant(grant, now = new Date()) {
  return Boolean(
    grant
      && grant.status === 'active'
      && !grant.revoked_at
      && (!grant.expires_at || new Date(grant.expires_at).getTime() > now.getTime()),
  );
}

export function canDownloadFipaDocument({ profileComplete, accessLevel, memberAllowed }) {
  return Boolean(
    profileComplete
      && (accessLevel === 'authenticated' || (accessLevel === 'member' && memberAllowed)),
  );
}

export function isValidFipaResourceId(value) {
  return UUID_PATTERN.test(String(value || '').trim());
}

export function parseFipaAccessRequestBody(body = {}) {
  const declaredVenueId = positiveIntegerOrNull(body.sede_id ?? body.venue_id);
  const venueNotListed = body.cancha_no_encontrada === true || body.venue_not_listed === true;
  const declared = {
    club_name: cleanText(body.nombre_cancha ?? body.club_nombre ?? body.organization_name, REQUEST_TEXT_LIMITS.club_name),
    country: cleanText(body.pais ?? body.country, REQUEST_TEXT_LIMITS.country),
    city: cleanText(body.ciudad ?? body.city, REQUEST_TEXT_LIMITS.city),
    address: cleanText(body.direccion_ubicacion ?? body.direccion ?? body.location, REQUEST_TEXT_LIMITS.address),
  };

  if (!declaredVenueId && !venueNotListed) {
    return {
      ok: false,
      status: 400,
      code: 'venue_selection_required',
      message: 'Elegí una sede o indicá que la cancha todavía no aparece en el listado.',
    };
  }
  if (!declaredVenueId && Object.values(declared).some((value) => !value)) {
    return {
      ok: false,
      status: 400,
      code: 'venue_details_required',
      message: 'Para revisar una cancha no listada necesitamos nombre, país, ciudad y dirección o ubicación.',
    };
  }

  return { ok: true, declaredVenueId, venueNotListed, declared };
}

export function parseFipaLibraryProfileBody(body = {}) {
  const purpose = cleanText(body.purpose ?? body.proposito, 60);
  const purposeOther = cleanText(body.purpose_other ?? body.otro_proposito, 240);
  const playsPadbol = cleanText(body.plays_padbol ?? body.juega_padbol, 20);
  const linkedToClub = cleanText(body.linked_to_club ?? body.vinculado_club, 20);
  const venue = parseFipaAccessRequestBody({
    ...body,
    cancha_no_encontrada: body.cancha_no_encontrada === true || body.venue_not_listed === true,
  });
  const hasVenueInput = Boolean(body.sede_id ?? body.venue_id ?? body.cancha_no_encontrada ?? body.venue_not_listed);
  const whatsapp = cleanText(body.whatsapp, 40);
  const whatsappConsent = body.whatsapp_consent === true;

  if (!FIPA_LIBRARY_PURPOSES.has(purpose)) {
    return { ok: false, status: 400, code: 'profile_purpose_required', message: 'Elegí para qué querés consultar la Biblioteca FIPA.' };
  }
  if (purpose === 'otro' && !purposeOther) {
    return { ok: false, status: 400, code: 'profile_other_purpose_required', message: 'Contanos brevemente el motivo de la consulta.' };
  }
  if (!FIPA_PROFILE_ANSWERS.has(playsPadbol) || !FIPA_PROFILE_ANSWERS.has(linkedToClub)) {
    return { ok: false, status: 400, code: 'profile_answers_required', message: 'Completá las preguntas sobre tu experiencia con Padbol.' };
  }
  if (linkedToClub === 'yes' && !hasVenueInput) {
    return { ok: false, status: 400, code: 'profile_venue_required', message: 'Elegí una sede o indicá que la cancha todavía no aparece en el listado.' };
  }
  if (hasVenueInput && !venue.ok) return venue;
  if (whatsapp && !whatsappConsent) {
    return { ok: false, status: 400, code: 'whatsapp_consent_required', message: 'Para guardar WhatsApp necesitamos tu autorización opcional.' };
  }

  return {
    ok: true,
    purpose,
    purposeOther: purpose === 'otro' ? purposeOther : null,
    playsPadbol,
    linkedToClub,
    venue: hasVenueInput
      ? venue
      : { ok: true, declaredVenueId: null, venueNotListed: false, declared: { club_name: null, country: null, city: null, address: null } },
    whatsapp,
    whatsappConsent: Boolean(whatsapp && whatsappConsent),
  };
}

export function requestReasonForVenue({ selectedVenue, declared, venueNotListed }) {
  if (!selectedVenue || !isOfficialFipaVenue(selectedVenue)) {
    return venueNotListed
      ? 'request_received_venue_not_listed'
      : 'request_received_venue_to_review';
  }

  const comparisons = [
    [declared?.club_name, selectedVenue.nombre],
    [declared?.country, selectedVenue.pais],
    [declared?.city, selectedVenue.ciudad],
    [declared?.address, selectedVenue.direccion],
  ].filter(([provided]) => Boolean(provided));
  const hasDifference = comparisons.some(
    ([provided, canonical]) => normalizedComparable(provided) !== normalizedComparable(canonical),
  );
  return hasDifference
    ? 'request_received_details_to_review'
    : 'request_received_official_venue';
}

export function publicFipaDocument(document, canDownload) {
  return {
    id: document.id,
    slug: document.slug,
    title: document.title,
    category: document.category,
    locale: document.locale,
    version: document.version,
    original_filename: document.original_filename,
    byte_size: document.byte_size,
    sha256: document.sha256,
    access_level: document.access_level,
    published_at: document.published_at,
    can_download: Boolean(canDownload),
  };
}

function safeRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    reason_code: row.reason_code,
    sede_id: row.sede_id,
    declared_sede_id: row.declared_sede_id,
    venue_not_listed: row.venue_not_listed,
    club_name: row.club_name,
    country: row.country,
    city: row.city,
    address: row.address,
    requested_at: row.requested_at,
    reviewed_at: row.reviewed_at,
  };
}

function safeGrant(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    sede_id: row.sede_id,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revocation_reason: row.revocation_reason,
  };
}

function safeProfile(row) {
  if (!row) return null;
  return {
    purpose: row.purpose,
    purpose_other: row.purpose_other,
    plays_padbol: row.plays_padbol,
    linked_to_club: row.linked_to_club,
    sede_id: row.sede_id,
    declared_sede_id: row.declared_sede_id,
    venue_not_listed: row.venue_not_listed,
    club_name: row.club_name,
    country: row.country,
    city: row.city,
    address: row.address,
    venue_reason_code: row.venue_reason_code,
    whatsapp_provided: Boolean(row.whatsapp),
    whatsapp_consent: Boolean(row.whatsapp_consent),
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

function operationalError(message, status = 503, code = 'fipa_library_unavailable') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function queryFailed(error, message) {
  if (error) throw operationalError(message);
}

export async function strictSuperAdminRole(supabaseAdmin, userId) {
  if (!userId) return false;
  const { data, error } = await supabaseAdmin
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
    .limit(1);
  queryFailed(error, 'No se pudo verificar el permiso administrativo.');
  return Boolean(data?.length);
}

async function activeManualGrant(supabaseAdmin, userId, now = new Date()) {
  const { data, error } = await supabaseAdmin
    .from('fipa_access_grants')
    .select('id, source, status, sede_id, granted_at, expires_at, revoked_at, revocation_reason')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('granted_at', { ascending: false });
  queryFailed(error, 'No se pudo comprobar la habilitación FIPA.');
  return (data || []).find((grant) => isActiveFipaGrant(grant, now)) || null;
}

async function verifiedOfficialMembership(supabaseAdmin, userId) {
  const { data: links, error: linksError } = await supabaseAdmin
    .from('sede_jugadores')
    .select('sede_id, origen')
    .eq('user_id', userId)
    .eq('estado', 'activo');
  queryFailed(linksError, 'No se pudo comprobar la membresía del club.');

  const eligibleLinks = (links || []).filter((link) => isVerifiedFipaMembershipOrigin(link.origen));
  const venueIds = [...new Set(eligibleLinks.map((link) => positiveIntegerOrNull(link.sede_id)).filter(Boolean))];
  if (!venueIds.length) return null;

  const { data: venues, error: venuesError } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre, pais, ciudad, licencia_activa, numero_licencia')
    .in('id', venueIds)
    .eq('licencia_activa', true);
  queryFailed(venuesError, 'No se pudo comprobar la licencia del club.');
  return (venues || []).find(isOfficialFipaVenue) || null;
}

async function resolveMemberAccess(supabaseAdmin, userId) {
  if (await strictSuperAdminRole(supabaseAdmin, userId)) {
    return { allowed: true, basis: 'super_admin', grant: null, venue: null };
  }
  const grant = await activeManualGrant(supabaseAdmin, userId);
  if (grant) return { allowed: true, basis: 'manual_grant', grant, venue: null };
  const venue = await verifiedOfficialMembership(supabaseAdmin, userId);
  if (venue) return { allowed: true, basis: 'verified_membership', grant: null, venue };
  return { allowed: false, basis: null, grant: null, venue: null };
}

async function loadLibraryProfile(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('fipa_library_profiles')
    .select('purpose, purpose_other, plays_padbol, linked_to_club, sede_id, declared_sede_id, venue_not_listed, club_name, country, city, address, venue_reason_code, whatsapp, whatsapp_consent, completed_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  queryFailed(error, 'No se pudo comprobar la ficha de interés.');
  return data || null;
}

async function auditEvent(supabaseAdmin, event) {
  const { error } = await supabaseAdmin.from('fipa_document_access_events').insert(event);
  queryFailed(error, 'No se pudo registrar la operación de acceso.');
}

async function requireUser(req, authUserFromBearer) {
  const user = await authUserFromBearer(req);
  if (!user?.id) throw operationalError('Iniciá sesión para acceder a la Biblioteca FIPA.', 401, 'authentication_required');
  return user;
}

function setPrivateResponseHeaders(res) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
}

function sendRouteError(res, route, error) {
  const status = Number(error?.status) || 500;
  console.error(`FIPA library ${route}:`, error?.message || error);
  return res.status(status).json({
    error: status >= 500 ? 'La Biblioteca FIPA no está disponible en este momento.' : error.message,
    code: error?.code || (status >= 500 ? 'fipa_library_unavailable' : 'request_failed'),
  });
}

export function registerFipaDocumentLibraryRoutes(app, {
  supabaseAdmin,
  serviceRoleConfigured,
  authUserFromBearer,
}) {
  function ensureServiceRole() {
    if (!serviceRoleConfigured || !supabaseAdmin) {
      throw operationalError('La Biblioteca FIPA requiere una conexión segura no configurada.');
    }
  }

  async function authenticated(req, res) {
    setPrivateResponseHeaders(res);
    const user = await requireUser(req, authUserFromBearer);
    ensureServiceRole();
    return user;
  }

  async function libraryAdmin(req, res) {
    const user = await authenticated(req, res);
    if (!(await strictSuperAdminRole(supabaseAdmin, user.id))) {
      throw operationalError('No autorizado.', 403, 'admin_permission_required');
    }
    return user;
  }

  app.get('/api/fipa/biblioteca/sedes-oficiales', async (req, res) => {
    try {
      await authenticated(req, res);
      const { data, error } = await supabaseAdmin
        .from('sedes')
        .select('id, nombre, pais, provincia, ciudad, direccion, licencia_activa, numero_licencia')
        .eq('licencia_activa', true)
        .order('nombre', { ascending: true });
      queryFailed(error, 'No se pudo cargar el listado de sedes.');
      const venues = (data || []).filter(isOfficialFipaVenue).map((venue) => ({
        id: venue.id,
        nombre: venue.nombre,
        pais: venue.pais,
        provincia: venue.provincia,
        ciudad: venue.ciudad,
        direccion: venue.direccion,
      }));
      return res.json({ venues });
    } catch (error) {
      return sendRouteError(res, 'GET venues', error);
    }
  });

  app.get('/api/fipa/biblioteca/estado', async (req, res) => {
    try {
      const user = await authenticated(req, res);
      const [member, profile, requestResult] = await Promise.all([
        resolveMemberAccess(supabaseAdmin, user.id),
        loadLibraryProfile(supabaseAdmin, user.id),
        supabaseAdmin
          .from('fipa_access_requests')
          .select('id, status, reason_code, sede_id, declared_sede_id, venue_not_listed, club_name, country, city, address, requested_at, reviewed_at, review_note')
          .eq('user_id', user.id)
          .order('requested_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      queryFailed(requestResult.error, 'No se pudo cargar el estado de la solicitud.');
      const latestRequest = safeRequest(requestResult.data);
      let reasonCode = !profile
        ? 'interest_profile_required'
        : member.allowed
          ? `access_granted_${member.basis}`
          : latestRequest?.reason_code || 'member_access_not_requested';
      if (profile && !member.allowed && latestRequest?.status === 'rejected') reasonCode = 'request_review_completed_no_access';
      if (profile && !member.allowed && latestRequest?.status === 'approved') reasonCode = 'member_access_not_available';
      return res.json({
        authenticated_access: Boolean(profile),
        member_access: Boolean(profile && member.allowed),
        access_basis: member.basis,
        reason_code: reasonCode,
        profile: safeProfile(profile),
        request: latestRequest,
        grant: safeGrant(member.grant),
        venue: member.venue ? { id: member.venue.id, nombre: member.venue.nombre } : null,
      });
    } catch (error) {
      return sendRouteError(res, 'GET state', error);
    }
  });

  app.put('/api/fipa/biblioteca/perfil', async (req, res) => {
    try {
      const user = await authenticated(req, res);
      const parsed = parseFipaLibraryProfileBody(req.body);
      if (!parsed.ok) throw operationalError(parsed.message, parsed.status, parsed.code);

      let selectedVenue = null;
      if (parsed.venue.declaredVenueId) {
        const venueResult = await supabaseAdmin
          .from('sedes')
          .select('id, nombre, pais, ciudad, direccion, licencia_activa, numero_licencia')
          .eq('id', parsed.venue.declaredVenueId)
          .maybeSingle();
        queryFailed(venueResult.error, 'No se pudo comprobar la sede elegida.');
        selectedVenue = venueResult.data || null;
      }
      if (
        parsed.linkedToClub === 'yes'
        && !isOfficialFipaVenue(selectedVenue)
        && Object.values(parsed.venue.declared).some((value) => !value)
      ) {
        throw operationalError(
          'Para revisar esta cancha necesitamos nombre, país, ciudad y dirección o ubicación.',
          400,
          'venue_details_required',
        );
      }
      const venueReasonCode = parsed.venue.declaredVenueId || parsed.venue.venueNotListed
        ? requestReasonForVenue({
          selectedVenue,
          declared: parsed.venue.declared,
          venueNotListed: parsed.venue.venueNotListed,
        })
        : 'profile_saved_without_venue';
      const officialVenueId = isOfficialFipaVenue(selectedVenue) ? selectedVenue.id : null;
      const { data, error } = await supabaseAdmin.rpc('guardar_perfil_biblioteca_fipa', {
        p_user_id: user.id,
        p_purpose: parsed.purpose,
        p_purpose_other: parsed.purposeOther,
        p_plays_padbol: parsed.playsPadbol,
        p_linked_to_club: parsed.linkedToClub,
        p_sede_id: officialVenueId,
        p_declared_sede_id: parsed.venue.declaredVenueId,
        p_venue_not_listed: parsed.venue.venueNotListed,
        p_club_name: parsed.venue.declared.club_name,
        p_country: parsed.venue.declared.country,
        p_city: parsed.venue.declared.city,
        p_address: parsed.venue.declared.address,
        p_venue_reason_code: venueReasonCode,
        p_whatsapp: parsed.whatsapp,
        p_whatsapp_consent: parsed.whatsappConsent,
      });
      queryFailed(error, 'No se pudo guardar la ficha de interés.');
      return res.json({
        ok: true,
        profile: data,
        reason_code: venueReasonCode,
        authenticated_access: true,
      });
    } catch (error) {
      return sendRouteError(res, 'PUT profile', error);
    }
  });

  app.post('/api/fipa/biblioteca/solicitudes', async (req, res) => {
    try {
      const user = await authenticated(req, res);
      const parsed = parseFipaAccessRequestBody(req.body);
      if (!parsed.ok) throw operationalError(parsed.message, parsed.status, parsed.code);

      let selectedVenue = null;
      if (parsed.declaredVenueId) {
        const venueResult = await supabaseAdmin
          .from('sedes')
          .select('id, nombre, pais, ciudad, direccion, licencia_activa, numero_licencia')
          .eq('id', parsed.declaredVenueId)
          .maybeSingle();
        queryFailed(venueResult.error, 'No se pudo comprobar la sede elegida.');
        selectedVenue = venueResult.data || null;
      }
      if (!isOfficialFipaVenue(selectedVenue) && Object.values(parsed.declared).some((value) => !value)) {
        throw operationalError(
          'Para revisar esta cancha necesitamos nombre, país, ciudad y dirección o ubicación.',
          400,
          'venue_details_required',
        );
      }
      const reasonCode = requestReasonForVenue({
        selectedVenue,
        declared: parsed.declared,
        venueNotListed: parsed.venueNotListed,
      });
      const officialVenueId = isOfficialFipaVenue(selectedVenue) ? selectedVenue.id : null;
      const { data, error } = await supabaseAdmin.rpc('registrar_solicitud_acceso_documentos_fipa', {
        p_user_id: user.id,
        p_email_snapshot: cleanText(user.email, 320),
        p_sede_id: officialVenueId,
        p_declared_sede_id: parsed.declaredVenueId,
        p_venue_not_listed: parsed.venueNotListed,
        p_club_name: parsed.declared.club_name,
        p_country: parsed.declared.country,
        p_city: parsed.declared.city,
        p_address: parsed.declared.address,
        p_reason_code: reasonCode,
      });
      if (error?.code === '23505') {
        throw operationalError('Ya hay una solicitud pendiente de revisión.', 409, 'request_already_pending');
      }
      queryFailed(error, 'No se pudo registrar la solicitud.');
      return res.status(201).json({
        ok: true,
        request_id: data,
        status: 'pending',
        reason_code: reasonCode,
        message: 'Recibimos los datos y los vamos a revisar.',
      });
    } catch (error) {
      return sendRouteError(res, 'POST request', error);
    }
  });

  app.get('/api/fipa/biblioteca/documentos', async (req, res) => {
    try {
      const user = await authenticated(req, res);
      const { data, error } = await supabaseAdmin
        .from('fipa_library_documents')
        .select('id, slug, title, category, locale, version, original_filename, byte_size, sha256, access_level, published_at')
        .eq('status', 'published')
        .order('sort_order', { ascending: true });
      queryFailed(error, 'No se pudo cargar el catálogo FIPA.');
      const needsMemberCheck = (data || []).some((document) => document.access_level === 'member');
      const [profile, member] = await Promise.all([
        loadLibraryProfile(supabaseAdmin, user.id),
        needsMemberCheck
          ? resolveMemberAccess(supabaseAdmin, user.id)
          : Promise.resolve({ allowed: false, basis: null }),
      ]);
      return res.json({
        profile_complete: Boolean(profile),
        member_access: Boolean(profile && member.allowed),
        access_basis: member.basis,
        documents: (data || []).map((document) => publicFipaDocument(
          document,
          canDownloadFipaDocument({
            profileComplete: Boolean(profile),
            accessLevel: document.access_level,
            memberAllowed: member.allowed,
          }),
        )),
      });
    } catch (error) {
      return sendRouteError(res, 'GET documents', error);
    }
  });

  app.post('/api/fipa/biblioteca/documentos/:documentId/descarga', async (req, res) => {
    let user = null;
    let document = null;
    const correlationId = crypto.randomUUID();
    try {
      user = await authenticated(req, res);
      if (!isValidFipaResourceId(req.params.documentId)) {
        throw operationalError('Documento inválido.', 400, 'invalid_document_id');
      }
      const documentResult = await supabaseAdmin
        .from('fipa_library_documents')
        .select('id, slug, title, version, storage_path, original_filename, access_level, status')
        .eq('id', req.params.documentId)
        .eq('status', 'published')
        .maybeSingle();
      queryFailed(documentResult.error, 'No se pudo comprobar el documento.');
      document = documentResult.data;
      if (!document) throw operationalError('El documento no está disponible.', 404, 'document_not_available');

      const profile = await loadLibraryProfile(supabaseAdmin, user.id);
      if (!profile) {
        await auditEvent(supabaseAdmin, {
          event_type: 'download_link_denied',
          actor_user_id: user.id,
          subject_user_id: user.id,
          document_id: document.id,
          correlation_id: correlationId,
          metadata: { reason_code: 'interest_profile_required' },
        });
        throw operationalError(
          'Completá tu ficha de interés antes de la primera descarga.',
          403,
          'interest_profile_required',
        );
      }

      let member = { allowed: false, basis: 'authenticated', grant: null, venue: null };
      if (document.access_level === 'member') {
        member = await resolveMemberAccess(supabaseAdmin, user.id);
        if (!member.allowed) {
          await auditEvent(supabaseAdmin, {
            event_type: 'download_link_denied',
            actor_user_id: user.id,
            subject_user_id: user.id,
            document_id: document.id,
            correlation_id: correlationId,
            metadata: { reason_code: 'member_access_required' },
          });
          throw operationalError(
            'Este documento requiere una membresía o habilitación vigente.',
            403,
            'member_access_required',
          );
        }
      }

      const windowStart = new Date(Date.now() - FIPA_DOWNLOAD_WINDOW_MS).toISOString();
      const { count, error: countError } = await supabaseAdmin
        .from('fipa_document_access_events')
        .select('id', { count: 'exact', head: true })
        .eq('actor_user_id', user.id)
        .eq('event_type', 'download_link_issued')
        .gte('occurred_at', windowStart);
      queryFailed(countError, 'No se pudo comprobar el límite de descargas.');
      if ((count || 0) >= FIPA_DOWNLOAD_LIMIT) {
        await auditEvent(supabaseAdmin, {
          event_type: 'download_link_denied',
          actor_user_id: user.id,
          subject_user_id: user.id,
          document_id: document.id,
          correlation_id: correlationId,
          metadata: { reason_code: 'download_rate_limited' },
        });
        throw operationalError('Esperá unos minutos antes de solicitar otra descarga.', 429, 'download_rate_limited');
      }

      await auditEvent(supabaseAdmin, {
        event_type: 'download_authorized',
        actor_user_id: user.id,
        subject_user_id: user.id,
        grant_id: member.grant?.id || null,
        document_id: document.id,
        correlation_id: correlationId,
        metadata: {
          access_basis: document.access_level === 'authenticated' ? 'authenticated' : member.basis,
          sede_id: member.venue?.id || member.grant?.sede_id || null,
          document_version: document.version,
        },
      });

      const signedResult = await supabaseAdmin.storage
        .from(FIPA_DOCUMENT_BUCKET)
        .createSignedUrl(document.storage_path, FIPA_SIGNED_URL_TTL_SECONDS, {
          download: document.original_filename,
        });
      if (signedResult.error || !signedResult.data?.signedUrl) {
        await auditEvent(supabaseAdmin, {
          event_type: 'download_link_failed',
          actor_user_id: user.id,
          subject_user_id: user.id,
          grant_id: member.grant?.id || null,
          document_id: document.id,
          correlation_id: correlationId,
          metadata: { stage: 'storage_sign' },
        });
        throw operationalError('No se pudo preparar la descarga.');
      }

      await auditEvent(supabaseAdmin, {
        event_type: 'download_link_issued',
        actor_user_id: user.id,
        subject_user_id: user.id,
        grant_id: member.grant?.id || null,
        document_id: document.id,
        correlation_id: correlationId,
        metadata: {
          access_basis: document.access_level === 'authenticated' ? 'authenticated' : member.basis,
          ttl_seconds: FIPA_SIGNED_URL_TTL_SECONDS,
          document_version: document.version,
        },
      });
      return res.json({
        download_url: signedResult.data.signedUrl,
        expires_in: FIPA_SIGNED_URL_TTL_SECONDS,
        filename: document.original_filename,
        correlation_id: correlationId,
      });
    } catch (error) {
      return sendRouteError(res, 'POST download', error);
    }
  });

  app.get('/api/admin/fipa/biblioteca/solicitudes', async (req, res) => {
    try {
      await libraryAdmin(req, res);
      const requestedStatus = cleanText(req.query?.status, 30) || 'pending';
      const allowedStatuses = new Set(['pending', 'approved', 'rejected', 'cancelled']);
      if (!allowedStatuses.has(requestedStatus)) {
        throw operationalError('Estado inválido.', 400, 'invalid_request_status');
      }
      const { data, error } = await supabaseAdmin
        .from('fipa_access_requests')
        .select('*')
        .eq('status', requestedStatus)
        .order('requested_at', { ascending: true });
      queryFailed(error, 'No se pudo cargar la bandeja de solicitudes.');
      return res.json({ requests: data || [] });
    } catch (error) {
      return sendRouteError(res, 'GET admin requests', error);
    }
  });

  app.patch('/api/admin/fipa/biblioteca/solicitudes/:id', async (req, res) => {
    try {
      const reviewer = await libraryAdmin(req, res);
      if (!isValidFipaResourceId(req.params.id)) {
        throw operationalError('Solicitud inválida.', 400, 'invalid_request_id');
      }
      const decision = cleanText(req.body?.decision, 20);
      const reviewNote = cleanText(req.body?.review_note ?? req.body?.nota, 1000);
      const expiresAt = cleanText(req.body?.expires_at, 80);
      if (!['approve', 'reject'].includes(decision)) {
        throw operationalError('Decisión inválida.', 400, 'invalid_review_decision');
      }
      if (!reviewNote) throw operationalError('La nota de revisión es obligatoria.', 400, 'review_note_required');
      if (expiresAt && !Number.isFinite(new Date(expiresAt).getTime())) {
        throw operationalError('La fecha de vencimiento no es válida.', 400, 'invalid_expiration');
      }
      const { data, error } = await supabaseAdmin.rpc('resolver_solicitud_acceso_documentos_fipa', {
        p_request_id: req.params.id,
        p_approve: decision === 'approve',
        p_reviewer_user_id: reviewer.id,
        p_review_note: reviewNote,
        p_expires_at: expiresAt || null,
      });
      if (error?.code === 'P0002') throw operationalError('La solicitud no existe.', 404, 'request_not_found');
      if (error?.code === 'P0001') throw operationalError('La solicitud ya fue revisada.', 409, 'request_already_reviewed');
      queryFailed(error, 'No se pudo resolver la solicitud.');
      return res.json({
        ok: true,
        result: data,
        reason_code: decision === 'approve' ? 'access_granted_manual_grant' : 'request_review_completed_no_access',
      });
    } catch (error) {
      return sendRouteError(res, 'PATCH admin request', error);
    }
  });

  app.get('/api/admin/fipa/biblioteca/habilitaciones', async (req, res) => {
    try {
      await libraryAdmin(req, res);
      const { data, error } = await supabaseAdmin
        .from('fipa_access_grants')
        .select('*')
        .order('granted_at', { ascending: false });
      queryFailed(error, 'No se pudieron cargar las habilitaciones.');
      return res.json({ grants: data || [] });
    } catch (error) {
      return sendRouteError(res, 'GET admin grants', error);
    }
  });

  app.post('/api/admin/fipa/biblioteca/habilitaciones/:id/revocar', async (req, res) => {
    try {
      const reviewer = await libraryAdmin(req, res);
      if (!isValidFipaResourceId(req.params.id)) {
        throw operationalError('Habilitación inválida.', 400, 'invalid_grant_id');
      }
      const reason = cleanText(req.body?.reason ?? req.body?.motivo, 1000);
      if (!reason) throw operationalError('El motivo de revocación es obligatorio.', 400, 'revocation_reason_required');
      const { data, error } = await supabaseAdmin.rpc('revocar_habilitacion_documentos_fipa', {
        p_grant_id: req.params.id,
        p_reviewer_user_id: reviewer.id,
        p_reason: reason,
      });
      if (error?.code === 'P0002') throw operationalError('La habilitación no existe.', 404, 'grant_not_found');
      if (error?.code === 'P0001') throw operationalError('La habilitación ya no está activa.', 409, 'grant_not_active');
      queryFailed(error, 'No se pudo revocar la habilitación.');
      return res.json({ ok: true, grant_id: data, reason_code: 'access_revoked' });
    } catch (error) {
      return sendRouteError(res, 'POST revoke', error);
    }
  });

  app.get('/api/admin/fipa/biblioteca/auditoria', async (req, res) => {
    try {
      await libraryAdmin(req, res);
      const limit = Math.min(Math.max(positiveIntegerOrNull(req.query?.limit) || 100, 1), 500);
      const { data, error } = await supabaseAdmin
        .from('fipa_document_access_events')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(limit);
      queryFailed(error, 'No se pudo cargar la auditoría.');
      return res.json({ events: data || [] });
    } catch (error) {
      return sendRouteError(res, 'GET audit', error);
    }
  });

  app.patch('/api/admin/sedes/:id/licencia-oficial', async (req, res) => {
    try {
      const reviewer = await libraryAdmin(req, res);
      const venueId = positiveIntegerOrNull(req.params.id);
      if (!venueId) throw operationalError('Sede inválida.', 400, 'invalid_venue');
      const licenseNumber = cleanText(req.body?.numero_licencia, 120);
      const licenseType = cleanText(req.body?.tipo_licencia, 80);
      const active = req.body?.licencia_activa;
      const licenseDate = cleanText(req.body?.fecha_licencia, 20);
      if (typeof active !== 'boolean') {
        throw operationalError('El estado de licencia es obligatorio.', 400, 'license_status_required');
      }
      if (active && !licenseNumber) {
        throw operationalError('Una licencia activa requiere número.', 400, 'license_number_required');
      }
      if (licenseDate && !/^\d{4}-\d{2}-\d{2}$/.test(licenseDate)) {
        throw operationalError('La fecha de licencia no es válida.', 400, 'invalid_license_date');
      }
      const { data, error } = await supabaseAdmin.rpc('actualizar_licencia_oficial_sede', {
        p_sede_id: venueId,
        p_numero_licencia: licenseNumber,
        p_fecha_licencia: licenseDate || null,
        p_licencia_activa: active,
        p_tipo_licencia: licenseType,
        p_reviewer_user_id: reviewer.id,
      });
      if (error?.code === 'P0002') throw operationalError('La sede no existe.', 404, 'venue_not_found');
      queryFailed(error, 'No se pudo actualizar la licencia.');
      return res.json({ ok: true, venue: data });
    } catch (error) {
      return sendRouteError(res, 'PATCH official license', error);
    }
  });
}
