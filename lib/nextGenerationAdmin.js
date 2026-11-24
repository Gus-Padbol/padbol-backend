import { assignNextGenerationRegistration } from './nextGenerationAssignment.js';
import { loadMappedRequests, sessionDto, canonicalSession, resolveVenueRequest } from './nextGenerationVenueMapping.js';

function ngAdminError(message, status = 500, code = 'NG_ADMIN_UNAVAILABLE') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const REGISTRATION_STATES = new Set(['borrador', 'confirmada', 'en_espera', 'cancelada']);

const isPositiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
const cleanText = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const bodyValue = (body, snake, camel) => body?.[snake] ?? body?.[camel];
const SESSION_STATES = new Set(['borrador', 'publicada', 'cerrada', 'cancelada']);

export function normalizeRegistrationPayload(body = {}) {
  const participantsInput = Array.isArray(body.participants) ? body.participants : [];
  return {
    conversationId: cleanText(bodyValue(body, 'conversation_id', 'conversationId'), 80),
    sedeId: Number(bodyValue(body, 'sede_id', 'venueId')),
    sessionId: cleanText(bodyValue(body, 'sesion_id', 'sessionId'), 80),
    category: cleanText(bodyValue(body, 'categoria', 'category'), 80),
    participants: participantsInput.map((item) => ({
      nombre: cleanText(item?.nombre ?? item?.name, 160),
      categoria: cleanText(item?.categoria ?? item?.category, 80) || null,
    })).filter((item) => item.nombre),
  };
}

export function normalizeSessionPayload(body = {}, { partial = false } = {}) {
  const has = (snake, camel) => body?.[snake] !== undefined || body?.[camel] !== undefined;
  const payload = {};
  if (has('venue_request_id', 'venueRequestId')) payload.venue_request_id = cleanText(bodyValue(body, 'venue_request_id', 'venueRequestId'), 80);
  if (!partial || has('sede_id', 'venueId')) payload.sede_id = Number(bodyValue(body, 'sede_id', 'venueId'));
  if (!partial || has('nombre_publico', 'name')) payload.nombre_publico = cleanText(bodyValue(body, 'nombre_publico', 'name'), 160);
  if (!partial || has('ciudad', 'city')) payload.ciudad = cleanText(bodyValue(body, 'ciudad', 'city'), 120) || null;
  if (!partial || has('pais', 'country')) payload.pais = cleanText(bodyValue(body, 'pais', 'country'), 120) || null;
  if (!partial || has('categoria', 'category')) payload.categoria = cleanText(bodyValue(body, 'categoria', 'category'), 80);
  if (!partial || has('comienza_at', 'startsAt')) payload.comienza_at = cleanText(bodyValue(body, 'comienza_at', 'startsAt'), 80);
  if (!partial || has('termina_at', 'endsAt')) payload.termina_at = cleanText(bodyValue(body, 'termina_at', 'endsAt'), 80) || null;
  if (!partial || has('cupo', 'capacity')) payload.cupo = Number(bodyValue(body, 'cupo', 'capacity'));
  if (!partial || has('estado', 'status')) payload.estado = cleanText(bodyValue(body, 'estado', 'status') || 'borrador', 40).toLowerCase();
  return payload;
}

export function validateSessionPayload(payload, { partial = false } = {}) {
  const required = (key) => !partial || Object.hasOwn(payload, key);
  if (required('sede_id') && !isPositiveInteger(payload.sede_id)) return 'NG_SEDE_INVALID';
  if (required('nombre_publico') && !payload.nombre_publico) return 'NG_SESSION_NAME_REQUIRED';
  if (required('categoria') && !payload.categoria) return 'NG_SESSION_CATEGORY_REQUIRED';
  if (required('categoria') && !['Sub-14','Sub-16','Sub-18'].includes(payload.categoria)) return 'NG_SESSION_CATEGORY_INVALID';
  if (required('ciudad') && (!payload.ciudad || payload.ciudad.length < 2)) return 'NG_SESSION_CITY_INVALID';
  if (required('pais') && (!payload.pais || payload.pais.length < 2)) return 'NG_SESSION_COUNTRY_INVALID';
  if (required('cupo') && (!Number.isInteger(payload.cupo) || payload.cupo < 1)) return 'NG_SESSION_CAPACITY_INVALID';
  if (required('estado') && !SESSION_STATES.has(payload.estado)) return 'NG_SESSION_STATUS_INVALID';
  if (required('comienza_at') && (!payload.comienza_at || Number.isNaN(Date.parse(payload.comienza_at)))) return 'NG_SESSION_START_INVALID';
  if (required('termina_at') && !payload.termina_at) return 'NG_SESSION_END_INVALID';
  if (payload.termina_at && Number.isNaN(Date.parse(payload.termina_at))) return 'NG_SESSION_END_INVALID';
  if (payload.comienza_at && payload.termina_at && Date.parse(payload.termina_at) <= Date.parse(payload.comienza_at)) return 'NG_SESSION_DATES_INVALID';
  return null;
}

export function normalizeVenueApplicationPayload(body = {}) {
  return {
    conversationId: cleanText(bodyValue(body, 'conversation_id', 'conversationId'), 80),
    venueName: cleanText(bodyValue(body, 'sede_club', 'venueName'), 180),
    city: cleanText(bodyValue(body, 'ciudad', 'city'), 120),
    country: cleanText(bodyValue(body, 'pais', 'country'), 120),
  };
}

export function canOperateRegistration(scope, registration) {
  if (scope?.superA || String(scope?.rol || '') === 'super_admin') return true;
  return String(scope?.rol || '') === 'admin_club'
    && isPositiveInteger(scope?.sedeId)
    && Number(scope.sedeId) === Number(registration?.sede_id);
}

function mapRpcError(error) {
  const token = ['NG_VENUE_UNLINKED', 'NG_SESSION_FULL', 'NG_ASSIGNMENT_REQUIRED', 'NG_REGISTRATION_CANCELLED', 'NG_SESSION_INVALID', 'NG_REGISTRATION_NOT_FOUND', 'NG_SESSION_NOT_FOUND']
    .find((code) => String(error?.message || '').includes(code));
  const status = ['NG_SESSION_FULL', 'NG_VENUE_UNLINKED'].includes(token) ? 409 : token?.endsWith('_NOT_FOUND') ? 404 : token ? 400 : 503;
  return ngAdminError(token === 'NG_SESSION_FULL' ? 'La jornada no tiene cupos disponibles.' : token === 'NG_VENUE_UNLINKED' ? 'La sede de la jornada requiere una vinculación canónica válida.' : token || 'No se pudo completar la operación.', status, token || 'NG_ADMIN_UNAVAILABLE');
}

function isNextGenerationConversation(row = {}) {
  const text = [row.origin, row.subject, row.inbound_body, row.source_ref]
    .map((value) => String(value || '').toLowerCase()).join(' ');
  return /next[ ._-]*generation|nextgen\.|program_registration|next_generation_venue/.test(text);
}

function fallbackState(row = {}) {
  const text = [row.subject, row.inbound_body, row.estado]
    .map((value) => String(value || '').toLowerCase()).join(' ');
  if (/cancelad/.test(text)) return 'cancelada';
  if (/confirmad/.test(text)) return 'confirmada';
  return 'en_espera';
}

export function buildNextGenerationOverviewFromCrm({ conversations = [], contacts = [] } = {}) {
  const contactById = new Map(contacts.map((row) => [String(row.id), row]));
  const inscripciones = conversations.filter(isNextGenerationConversation).map((row) => {
    const contact = contactById.get(String(row.contact_id || '')) || {};
    return {
      id: row.id,
      contacto_nombre: contact.nombre || 'Contacto web',
      contacto_email: contact.email_normalized || null,
      contacto_whatsapp: contact.phone_normalized || null,
      estado: fallbackState(row),
      created_at: row.created_at || row.received_at,
      updated_at: row.updated_at || row.received_at,
      jornada: null,
      sede: row.sede_id ? { id: row.sede_id, sede_club: `Sede ${row.sede_id}` } : null,
      participantes: [],
      eventos: [{ id: `crm-${row.id}`, tipo: 'crm.formulario', created_at: row.received_at || row.created_at }],
      origen_crm: true,
    };
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return {
    summary: {
      total: inscripciones.length,
      confirmadas: inscripciones.filter((row) => row.estado === 'confirmada').length,
      en_espera: inscripciones.filter((row) => row.estado === 'en_espera').length,
      canceladas: inscripciones.filter((row) => row.estado === 'cancelada').length,
    },
    inscripciones,
    sedes: [],
    source: 'crm',
  };
}

export function buildNextGenerationOverview({ sessions = [], venues = [], registrations = [], participants = [], events = [] } = {}) {
  const venueById = new Map(venues.map((row) => [String(row.id), row]));
  const sessionById = new Map(sessions.map((row) => [String(row.id), row]));
  const participantByRegistration = new Map();
  for (const row of participants) {
    const key = String(row.inscripcion_id || '');
    if (!key) continue;
    const current = participantByRegistration.get(key) || [];
    if (!current.some((item) => String(item.id) === String(row.id))) current.push(row);
    participantByRegistration.set(key, current);
  }
  const eventByRegistration = new Map();
  const seenEventIds = new Set();
  for (const row of events) {
    const eventId = String(row.id || '');
    const registrationId = String(row.inscripcion_id || '');
    if (!eventId || !registrationId || seenEventIds.has(eventId)) continue;
    seenEventIds.add(eventId);
    const current = eventByRegistration.get(registrationId) || [];
    current.push(row);
    eventByRegistration.set(registrationId, current);
  }

  const seenRegistrations = new Set();
  const rows = [];
  for (const row of registrations) {
    const id = String(row.id || '');
    if (!id || seenRegistrations.has(id)) continue;
    seenRegistrations.add(id);
    const estado = String(row.estado || '').toLowerCase();
    if (!REGISTRATION_STATES.has(estado)) continue;
    const session = sessionById.get(String(row.sesion_id || '')) || null;
    const venue = session ? venueById.get(String(session.sede_id || '')) || null : null;
    rows.push({
      ...row,
      estado,
      jornada: session,
      sede: venue,
      participantes: participantByRegistration.get(id) || [],
      eventos: (eventByRegistration.get(id) || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    });
  }
  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return {
    summary: {
      total: rows.length,
      borradores: rows.filter((row) => row.estado === 'borrador').length,
      confirmadas: rows.filter((row) => row.estado === 'confirmada').length,
      en_espera: rows.filter((row) => row.estado === 'en_espera').length,
      canceladas: rows.filter((row) => row.estado === 'cancelada').length,
    },
    inscripciones: rows,
    sedes: venues,
    jornadas: sessions,
    source: 'operational',
  };
}

export function registerNextGenerationAdminRoutes(app, { supabaseAdmin, adminListScopeFromRequest, pgPool } = {}) {
  if (!supabaseAdmin?.from || typeof adminListScopeFromRequest !== 'function') return;

  const readScope = async (req) => {
    const scope = await adminListScopeFromRequest(req);
    if (!scope) throw ngAdminError('No autorizado.', 401, 'NG_ADMIN_UNAUTHENTICATED');
    const isVenueAdmin = String(scope.rol || '') === 'admin_club' && isPositiveInteger(scope.sedeId);
    if (!scope.superA && String(scope.rol || '') !== 'super_admin' && !isVenueAdmin) {
      throw ngAdminError('No tienes acceso a Next Generation.', 403, 'NG_ADMIN_FORBIDDEN');
    }
    return { scope, isVenueAdmin };
  };

  const loadRegistration = async (id) => {
    const result = await supabaseAdmin.from('ng_inscripciones')
      .select('id,sesion_id,sede_id,crm_conversation_id,contacto_nombre,contacto_email,contacto_whatsapp,categoria,estado,posicion_espera,continuidad_estado,cancel_reason,created_at,updated_at')
      .eq('id', id).maybeSingle();
    if (result.error) throw ngAdminError('No se pudo cargar la inscripción.', 503);
    if (!result.data) throw ngAdminError('La inscripción no existe.', 404, 'NG_REGISTRATION_NOT_FOUND');
    return result.data;
  };

  const assertRegistrationAccess = async (req, id) => {
    const { scope } = await readScope(req);
    const registration = await loadRegistration(id);
    if (!canOperateRegistration(scope, registration)) throw ngAdminError('No tienes acceso a esta inscripción.', 403, 'NG_ADMIN_FORBIDDEN');
    return { scope, registration };
  };

  const sendError = (res, error) => res.status(error.status || 500).json({
    error: error.message || 'Error interno', code: error.code || 'NG_ADMIN_UNAVAILABLE',
  });

  app.get('/api/admin/next-generation/overview', async (req, res) => {
    try {
      const { scope, isVenueAdmin } = await readScope(req);
      const mappedRequests = await loadMappedRequests(supabaseAdmin, isVenueAdmin ? Number(scope.sedeId) : null);
      let sessionsQuery = supabaseAdmin.from('ng_sesiones')
        .select('id,sede_id,nombre_publico,ciudad,pais,categoria,comienza_at,termina_at,cupo,estado')
        .order('comienza_at', { ascending: false }).limit(500);
      let canonicalVenuesQuery = supabaseAdmin.from('sedes').select('id,nombre,ciudad,pais').order('nombre').limit(1000);
      let venuesQuery = Promise.resolve({ data: mappedRequests.map(row => ({ ...row, contacto_nombre: row.nombre, contacto_email: row.email, contacto_whatsapp: row.whatsapp, crm_conversation_id: null })) });
      let registrationsQuery = supabaseAdmin.from('ng_inscripciones').select('id,sesion_id,sede_id,crm_conversation_id,contacto_nombre,contacto_email,contacto_whatsapp,categoria,estado,posicion_espera,continuidad_estado,cancel_reason,created_at,updated_at').order('created_at', { ascending: false }).limit(2000);
      if (isVenueAdmin) {
        // The database must apply the venue predicate before LIMIT; filtering
        // the capped global response can hide this venue behind other PPs.
        registrationsQuery = registrationsQuery.eq('sede_id', Number(scope.sedeId));
        sessionsQuery = mappedRequests.length ? sessionsQuery.in('sede_id', mappedRequests.map(row => row.id)) : Promise.resolve({ data: [] });
        canonicalVenuesQuery = canonicalVenuesQuery.eq('id', Number(scope.sedeId));
        // Request UUIDs above were derived under the canonical PP predicate before LIMIT.
      }
      const queries = await Promise.all([
        Promise.resolve(sessionsQuery).then(result => result.error ? result : ({ ...result, data: (result.data || []).map(row => sessionDto(row, mappedRequests, { allowUnlinked: !isVenueAdmin })) })),
        venuesQuery,
        registrationsQuery,
        isVenueAdmin ? Promise.resolve({ data: [] }) : supabaseAdmin.from('ng_inscripcion_participantes').select('id,inscripcion_id,nombre,categoria,created_at').limit(5000),
        isVenueAdmin ? Promise.resolve({ data: [] }) : supabaseAdmin.from('ng_inscripcion_eventos').select('id,inscripcion_id,sesion_id,tipo,actor,detalle,created_at').order('created_at', { ascending: true }).limit(10000),
        canonicalVenuesQuery,
      ]);
      const failed = queries.find((result) => result.error);
      if (failed) {
        throw ngAdminError('La operación Next Generation todavía no está disponible.', 503, 'NG_SCHEMA_UNAVAILABLE');
      }
      res.set('cache-control', 'private, no-store');
      const sessions = queries[0].data || [];
      const allowedSessionIds = isVenueAdmin
        ? new Set(sessions.map((row) => String(row.id)))
        : null;
      const registrations = allowedSessionIds
        ? (queries[2].data || []).filter((row) => Number(row.sede_id) === Number(scope.sedeId) && (!row.sesion_id || allowedSessionIds.has(String(row.sesion_id))))
        : (queries[2].data || []);
      const registrationIds = new Set(registrations.map((row) => String(row.id)));
      if (isVenueAdmin && registrationIds.size) {
        // Bound the encoded PostgREST URL (100 persisted UUIDs per request),
        // not one query per registration or an unbounded 2000-ID URL. Each
        // collection shares its ORIGINAL total row budget across all batches.
        const ids = [...registrationIds];
        const loadChildren = async (table, columns, budget, ordered = false) => {
          const data = [];
          for (let offset = 0; offset < ids.length && data.length < budget; offset += 100) {
            let query = supabaseAdmin.from(table).select(columns)
              .in('inscripcion_id', ids.slice(offset, offset + 100));
            if (ordered) query = query.order('created_at', { ascending: true });
            const result = await query.limit(budget - data.length);
            if (result.error) throw ngAdminError('La operación Next Generation todavía no está disponible.', 503, 'NG_SCHEMA_UNAVAILABLE');
            data.push(...(result.data || []));
          }
          return { data };
        };
        [queries[3], queries[4]] = await Promise.all([
          loadChildren('ng_inscripcion_participantes', 'id,inscripcion_id,nombre,categoria,created_at', 5000),
          loadChildren('ng_inscripcion_eventos', 'id,inscripcion_id,sesion_id,tipo,actor,detalle,created_at', 10000, true),
        ]);
      }
      const overview = buildNextGenerationOverview({
        sessions, venues: queries[5].data || [], registrations,
        participants: (queries[3].data || []).filter((row) => registrationIds.has(String(row.inscripcion_id))),
        events: (queries[4].data || []).filter((row) => registrationIds.has(String(row.inscripcion_id))),
      });
      res.json({
        ...overview,
        participants: overview.inscripciones,
        venueApplications: queries[1].data || [],
        sessions: overview.jornadas,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/admin/next-generation/registrations/from-crm', async (req, res) => {
    let insertedId = null;
    try {
      const { scope } = await readScope(req);
      const payload = normalizeRegistrationPayload(req.body);
      if (!payload.conversationId || !isPositiveInteger(payload.sedeId) || !payload.sessionId || !payload.category || !payload.participants.length) {
        throw ngAdminError('Conversación, sede, jornada, categoría y participante son obligatorios.', 400, 'NG_REGISTRATION_INVALID');
      }
      if (!canOperateRegistration(scope, { sede_id: payload.sedeId })) throw ngAdminError('No tienes acceso a esta sede.', 403, 'NG_ADMIN_FORBIDDEN');
      const existing = await supabaseAdmin.from('ng_inscripciones').select('*').eq('crm_conversation_id', payload.conversationId).maybeSingle();
      if (existing.error) throw ngAdminError('No se pudo verificar la conversión.', 503);
      if (existing.data) return res.status(200).json({ registration: existing.data, created: false });

      const [conversationResult, sessionResult] = await Promise.all([
        supabaseAdmin.from('crm_conversations').select('id,contact_id,sede_id,subject,origin').eq('id', payload.conversationId).maybeSingle(),
        supabaseAdmin.from('ng_sesiones').select('id,sede_id,categoria,estado').eq('id', payload.sessionId).maybeSingle(),
      ]);
      if (conversationResult.error || !conversationResult.data) throw ngAdminError('La conversación CRM no existe.', 404, 'NG_CRM_CONVERSATION_NOT_FOUND');
      if (sessionResult.error || !sessionResult.data || Number((await canonicalSession(supabaseAdmin, sessionResult.data)).sede_id) !== payload.sedeId) throw ngAdminError('La jornada no pertenece a la sede.', 400, 'NG_SESSION_INVALID');
      if (!scope.superA && conversationResult.data.sede_id != null && Number(conversationResult.data.sede_id) !== payload.sedeId) throw ngAdminError('La conversación pertenece a otra sede.', 403, 'NG_ADMIN_FORBIDDEN');
      const contactResult = await supabaseAdmin.from('crm_contacts').select('nombre,email_normalized,phone_normalized').eq('id', conversationResult.data.contact_id).maybeSingle();
      if (contactResult.error) throw ngAdminError('No se pudo cargar el contacto.', 503);
      const contact = contactResult.data || {};
      const inserted = await supabaseAdmin.from('ng_inscripciones').insert({
        sesion_id: payload.sessionId, sede_id: payload.sedeId, crm_conversation_id: payload.conversationId,
        contacto_nombre: cleanText(contact.nombre, 160) || payload.participants[0].nombre,
        contacto_email: contact.email_normalized || null, contacto_whatsapp: contact.phone_normalized || null,
        categoria: payload.category, estado: 'borrador', created_by: scope.authUserId || null,
      }).select('*').single();
      if (inserted.error) {
        if (String(inserted.error.code) === '23505') {
          const retry = await supabaseAdmin.from('ng_inscripciones').select('*').eq('crm_conversation_id', payload.conversationId).maybeSingle();
          if (retry.data) return res.status(200).json({ registration: retry.data, created: false });
        }
        throw ngAdminError('No se pudo crear la inscripción.', 503);
      }
      insertedId = inserted.data.id;
      const participantsResult = await supabaseAdmin.from('ng_inscripcion_participantes').insert(payload.participants.map((item) => ({
        inscripcion_id: insertedId, nombre: item.nombre, categoria: item.categoria || payload.category,
      })));
      if (participantsResult.error) throw ngAdminError('No se pudieron guardar los participantes.', 503);
      await supabaseAdmin.from('ng_inscripcion_eventos').insert({
        inscripcion_id: insertedId, sesion_id: payload.sessionId, tipo: 'convertida_desde_crm', actor: scope.email,
        detalle: { crm_conversation_id: payload.conversationId },
      });
      res.status(201).json({ registration: inserted.data, created: true });
    } catch (error) {
      if (insertedId) await supabaseAdmin.from('ng_inscripciones').delete().eq('id', insertedId);
      sendError(res, error);
    }
  });

  app.patch('/api/admin/next-generation/registrations/:id/assignment', async (req, res) => {
    try {
      const { scope, registration } = await assertRegistrationAccess(req, req.params.id);
      if (registration.estado === 'cancelada') throw ngAdminError('La inscripción está cancelada.', 400, 'NG_REGISTRATION_CANCELLED');
      const sedeId = Number(bodyValue(req.body, 'sede_id', 'venueId') ?? registration.sede_id);
      const sessionId = cleanText(bodyValue(req.body, 'sesion_id', 'sessionId') ?? registration.sesion_id, 80);
      const category = cleanText(bodyValue(req.body, 'categoria', 'category') ?? registration.categoria, 80);
      if (!isPositiveInteger(sedeId) || !sessionId || !category) throw ngAdminError('Sede, jornada y categoría son obligatorias.', 400, 'NG_ASSIGNMENT_REQUIRED');
      if (!canOperateRegistration(scope, { sede_id: sedeId })) throw ngAdminError('No tienes acceso a la sede de destino.', 403, 'NG_ADMIN_FORBIDDEN');
      const updated = await assignNextGenerationRegistration(pgPool, {
        registrationId: registration.id, sedeId, sessionId, category, scope,
      });
      res.json({ registration: updated });
    } catch (error) { sendError(res, error); }
  });

  const rpcAction = (path, rpcName, argsFactory) => app.post(path, async (req, res) => {
    try {
      const { scope, registration } = await assertRegistrationAccess(req, req.params.id);
      const result = await supabaseAdmin.rpc(rpcName, argsFactory(req, scope, registration));
      if (result.error) throw mapRpcError(result.error);
      res.json({ registration: result.data });
    } catch (error) { sendError(res, error); }
  });
  rpcAction('/api/admin/next-generation/registrations/:id/confirm', 'ng_confirm_registration', (req, scope) => ({ p_registration_id: req.params.id, p_actor: scope.email }));
  rpcAction('/api/admin/next-generation/registrations/:id/waitlist', 'ng_waitlist_registration', (req, scope) => ({ p_registration_id: req.params.id, p_actor: scope.email }));
  rpcAction('/api/admin/next-generation/registrations/:id/cancel', 'ng_cancel_registration', (req, scope) => ({ p_registration_id: req.params.id, p_actor: scope.email, p_reason: cleanText(req.body?.reason, 500) || null }));

  app.post('/api/admin/next-generation/sessions/:id/promote-waitlist', async (req, res) => {
    try {
      const { scope } = await readScope(req);
      const session = await supabaseAdmin.from('ng_sesiones').select('id,sede_id').eq('id', req.params.id).maybeSingle();
      if (session.error || !session.data) throw ngAdminError('La jornada no existe.', 404, 'NG_SESSION_NOT_FOUND');
      if (!canOperateRegistration(scope, { sede_id: (await canonicalSession(supabaseAdmin, session.data)).sede_id })) throw ngAdminError('No tienes acceso a esta jornada.', 403, 'NG_ADMIN_FORBIDDEN');
      const result = await supabaseAdmin.rpc('ng_promote_waitlist', { p_session_id: req.params.id, p_actor: scope.email });
      if (result.error) throw mapRpcError(result.error);
      res.json({ registration: result.data || null });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/admin/next-generation/sessions', async (req, res) => {
    try {
      const { scope, isVenueAdmin } = await readScope(req);
      const payload = normalizeSessionPayload(req.body);
      if (isVenueAdmin) {
        if (isPositiveInteger(payload.sede_id) && Number(payload.sede_id) !== Number(scope.sedeId)) throw ngAdminError('No puedes crear jornadas para otra sede.', 403, 'NG_ADMIN_FORBIDDEN');
        payload.sede_id = Number(scope.sedeId);
      }
      const venue = await supabaseAdmin.from('sedes').select('id,nombre,ciudad,pais').eq('id', payload.sede_id).maybeSingle();
      if (venue.error || !venue.data) throw ngAdminError('La sede no existe.', 400, 'NG_SEDE_INVALID');
      payload.ciudad ??= venue.data.ciudad || null;
      payload.pais ??= venue.data.pais || null;
      const invalid = validateSessionPayload(payload);
      if (invalid) throw ngAdminError('Revisa los datos de la jornada.', 400, invalid);
      const requestId = await resolveVenueRequest(supabaseAdmin, payload.sede_id, payload.venue_request_id);
      const { venue_request_id: _request, ...sessionPayload } = payload;
      sessionPayload.sede_id = requestId;
      if (!String(scope.email || '').trim()) throw ngAdminError('No se pudo identificar al administrador de la jornada.', 503, 'NG_SESSION_ACTOR_REQUIRED');
      sessionPayload.creado_por = scope.email;
      const inserted = await supabaseAdmin.from('ng_sesiones').insert(sessionPayload)
        .select('id,sede_id,nombre_publico,ciudad,pais,categoria,comienza_at,termina_at,cupo,estado').single();
      if (inserted.error) throw ngAdminError('No se pudo crear la jornada.', 503, 'NG_ADMIN_UNAVAILABLE');
      res.status(201).json({ session: await canonicalSession(supabaseAdmin, inserted.data) });
    } catch (error) { sendError(res, error); }
  });

  app.patch('/api/admin/next-generation/sessions/:id', async (req, res) => {
    try {
      const { scope, isVenueAdmin } = await readScope(req);
      const current = await supabaseAdmin.from('ng_sesiones')
        .select('id,sede_id,nombre_publico,ciudad,pais,categoria,comienza_at,termina_at,cupo,estado')
        .eq('id', req.params.id).maybeSingle();
      if (current.error) throw ngAdminError('No se pudo cargar la jornada.', 503);
      if (!current.data) throw ngAdminError('La jornada no existe.', 404, 'NG_SESSION_NOT_FOUND');
      const currentDto = await canonicalSession(supabaseAdmin, current.data);
      if (!canOperateRegistration(scope, { sede_id: currentDto.sede_id })) throw ngAdminError('No tienes acceso a esta jornada.', 403, 'NG_ADMIN_FORBIDDEN');
      const patch = normalizeSessionPayload(req.body, { partial: true });
      if (!Object.keys(patch).length) throw ngAdminError('No hay cambios para guardar.', 400, 'NG_SESSION_UPDATE_EMPTY');
      if (isVenueAdmin && Object.hasOwn(patch, 'sede_id') && Number(patch.sede_id) !== Number(scope.sedeId)) throw ngAdminError('No puedes mover la jornada a otra sede.', 403, 'NG_ADMIN_FORBIDDEN');
      const merged = { ...currentDto, ...patch };
      const invalid = validateSessionPayload(merged);
      if (invalid) throw ngAdminError('Revisa los datos de la jornada.', 400, invalid);
      if (Object.hasOwn(patch, 'sede_id') && Number(patch.sede_id) !== Number(currentDto.sede_id)) {
        const venue = await supabaseAdmin.from('sedes').select('id').eq('id', patch.sede_id).maybeSingle();
        if (venue.error || !venue.data) throw ngAdminError('La sede no existe.', 400, 'NG_SEDE_INVALID');
      }
      // Atomic RPC locks the same session row as confirmation/promotion and
      // rechecks capacity and the authenticated venue scope after the lock.
      const updated = await supabaseAdmin.rpc('ng_update_session', {
        p_session_id: current.data.id, p_patch: patch,
        p_sede_scope: isVenueAdmin ? Number(scope.sedeId) : null,
      });
      if (updated.error) {
        const code = String(updated.error.message || '');
        if (code === 'NG_SESSION_CAPACITY_BELOW_CONFIRMED') throw ngAdminError('El cupo no puede ser menor que las inscripciones confirmadas.', 409, code);
        if (code === 'NG_SESSION_HAS_REGISTRATIONS') throw ngAdminError('No se puede mover una jornada que ya tiene inscripciones.', 409, code);
        if (['NG_VENUE_UNLINKED', 'NG_VENUE_AMBIGUOUS', 'NG_VENUE_REQUEST_INVALID'].includes(code)) throw ngAdminError('La sede de la jornada requiere revisión de su vinculación.', 409, code);
        if (code === 'NG_ADMIN_FORBIDDEN') throw ngAdminError('No tienes acceso a esta jornada.', 403, code);
        if (code === 'NG_SESSION_NOT_FOUND') throw ngAdminError('La jornada no existe.', 404, code);
        if (code === 'NG_SEDE_INVALID') throw ngAdminError('La sede no existe.', 400, code);
        if (/^NG_SESSION_(NAME_REQUIRED|CATEGORY_REQUIRED|CATEGORY_INVALID|CITY_INVALID|COUNTRY_INVALID|CAPACITY_INVALID|STATUS_INVALID|START_INVALID|END_INVALID|DATES_INVALID)$/.test(code)) throw ngAdminError('Revisa los datos de la jornada.', 400, code);
        throw ngAdminError('No se pudo actualizar la jornada.', 503);
      }
      if (!updated.data || typeof updated.data !== 'object') throw ngAdminError('No se pudo actualizar la jornada.', 503);
      res.json({ session: updated.data });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/admin/next-generation/venue-applications/from-crm', async (req, res) => {
    try {
      const { scope } = await readScope(req);
      if (!scope.superA && String(scope.rol || '') !== 'super_admin') throw ngAdminError('Sólo el Super Admin puede crear postulaciones de sede.', 403, 'NG_ADMIN_FORBIDDEN');
      const payload = normalizeVenueApplicationPayload(req.body);
      if (!payload.conversationId || !payload.venueName || !payload.city || !payload.country) throw ngAdminError('Conversación, nombre de sede, ciudad y país son obligatorios.', 400, 'NG_VENUE_APPLICATION_INVALID');
      const existing = await supabaseAdmin.from('ng_solicitudes_sede').select('*').eq('crm_conversation_id', payload.conversationId).maybeSingle();
      if (existing.error) throw ngAdminError('No se pudo verificar la postulación.', 503);
      if (existing.data) return res.status(200).json({ venueApplication: existing.data, created: false });
      const conversation = await supabaseAdmin.from('crm_conversations')
        .select('id,contact_id,origin,subject,inbound_body,source_ref').eq('id', payload.conversationId).maybeSingle();
      if (conversation.error || !conversation.data) throw ngAdminError('La conversación CRM no existe.', 404, 'NG_CRM_CONVERSATION_NOT_FOUND');
      const conversationText = [conversation.data.origin, conversation.data.subject, conversation.data.inbound_body, conversation.data.source_ref]
        .map((value) => String(value || '').toLowerCase()).join(' ');
      if (!/next_generation_venue|next[ ._-]*generation.*(?:sede|venue|adhesi[oó]n)|(?:sede|venue|adhesi[oó]n).*next[ ._-]*generation/.test(conversationText)) {
        throw ngAdminError('La conversación no es una postulación de sede Next Generation.', 400, 'NG_VENUE_CONVERSATION_INVALID');
      }
      const contact = await supabaseAdmin.from('crm_contacts').select('nombre,email_normalized,phone_normalized').eq('id', conversation.data.contact_id).maybeSingle();
      if (contact.error) throw ngAdminError('No se pudo cargar el contacto.', 503);
      const inserted = await supabaseAdmin.from('ng_solicitudes_sede').insert({
        crm_conversation_id: payload.conversationId, sede_club: payload.venueName, ciudad: payload.city, pais: payload.country,
        contacto_nombre: contact.data?.nombre || null, contacto_email: contact.data?.email_normalized || null,
        contacto_whatsapp: contact.data?.phone_normalized || null, estado: 'recibida', created_by: scope.authUserId || null,
      }).select('*').single();
      if (inserted.error) {
        if (String(inserted.error.code) === '23505') {
          const retry = await supabaseAdmin.from('ng_solicitudes_sede').select('*').eq('crm_conversation_id', payload.conversationId).maybeSingle();
          if (retry.data) return res.status(200).json({ venueApplication: retry.data, created: false });
        }
        throw ngAdminError('No se pudo crear la postulación.', 503);
      }
      res.status(201).json({ venueApplication: inserted.data, created: true });
    } catch (error) { sendError(res, error); }
  });

  app.patch('/api/admin/next-generation/venues/:id/sede', async (req, res) => {
    try {
      const scope = await adminListScopeFromRequest(req);
      if (!scope) throw ngAdminError('No autorizado.', 401, 'NG_ADMIN_UNAUTHENTICATED');
      if (!scope.superA && String(scope.rol || '') !== 'super_admin') throw ngAdminError('Sólo el Super Admin puede vincular sedes.', 403, 'NG_ADMIN_FORBIDDEN');
      const sedeId = Number(req.body?.sede_id);
      if (!Number.isInteger(sedeId) || sedeId <= 0) throw ngAdminError('Sede canónica inválida.', 400, 'NG_SEDE_INVALID');
      const canonical = await supabaseAdmin.from('sedes').select('id').eq('id', sedeId).maybeSingle();
      if (canonical.error || !canonical.data) throw ngAdminError('La sede canónica no existe.', 400, 'NG_SEDE_INVALID');
      const updated = await supabaseAdmin.from('ng_solicitudes_sede').update({ canonical_sede_id: sedeId, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('id,canonical_sede_id,sede_club,ciudad,pais').single();
      if (String(updated.error?.code) === '23505') throw ngAdminError('La sede canónica ya está vinculada a otra solicitud.', 409, 'NG_VENUE_ALREADY_LINKED');
      if (updated.error) throw ngAdminError('No se pudo vincular la sede.', 503, 'NG_ADMIN_UNAVAILABLE');
      res.json(updated.data);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || 'Error interno', code: error.code || 'NG_ADMIN_UNAVAILABLE' });
    }
  });

  app.patch('/api/admin/next-generation/venues/:id', async (req, res) => {
    try {
      const { scope } = await readScope(req);
      if (!scope.superA && String(scope.rol || '') !== 'super_admin') throw ngAdminError('Sólo el Super Admin puede evaluar postulaciones de sedes.', 403, 'NG_ADMIN_FORBIDDEN');
      const patch = { updated_at: new Date().toISOString() };
      if (req.body?.estado != null) {
        const estado = cleanText(req.body.estado, 40).toLowerCase();
        if (!['recibida', 'en_evaluacion', 'aprobada', 'rechazada'].includes(estado)) throw ngAdminError('Estado de postulación inválido.', 400, 'NG_VENUE_STATUS_INVALID');
        patch.estado = estado;
      }
      if (req.body?.canonical_sede_id !== undefined) {
        const sedeId = Number(req.body.canonical_sede_id);
        if (!isPositiveInteger(sedeId)) throw ngAdminError('Sede canónica inválida.', 400, 'NG_SEDE_INVALID');
        const canonical = await supabaseAdmin.from('sedes').select('id').eq('id', sedeId).maybeSingle();
        if (canonical.error || !canonical.data) throw ngAdminError('La sede canónica no existe.', 400, 'NG_SEDE_INVALID');
        patch.canonical_sede_id = sedeId;
      }
      if (Object.keys(patch).length === 1) throw ngAdminError('No hay cambios para guardar.', 400, 'NG_VENUE_UPDATE_EMPTY');
      const updated = await supabaseAdmin.from('ng_solicitudes_sede').update(patch).eq('id', req.params.id)
        .select('id,canonical_sede_id,crm_conversation_id,sede_club,ciudad,pais,contacto_nombre,contacto_email,contacto_whatsapp,estado,created_at,updated_at').single();
      if (updated.error) throw ngAdminError('No se pudo actualizar la postulación.', 503);
      res.json({ venueApplication: updated.data });
    } catch (error) { sendError(res, error); }
  });
}
