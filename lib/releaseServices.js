import { mountAliasAvailabilityRoute } from './publicAliasAvailability.js';
import { resolveStoredRoleForVerifiedUser } from './roleIdentity.js';
import { mountCommercialReleaseRoutes } from '../routes/commercialRelease.js';
import { pushSendRateLimit, pushTokensRateLimit } from './rateLimit.js';
import { createLegacyPushBridge, mountLegacyPushBridgeRoute } from './legacyPushBridge.js';
import { configureMobilePushBridge } from '../utils/push.js';
import { backendReadiness, backendSqlReadiness } from './backendRuntime.js';
import { registerFipaDocumentLibraryRoutes } from './fipaDocumentLibrary.js';
import { createMobilePushService, registerMobilePushRoutes } from './mobilePushNotifications.js';
import { registerAdminPushRoutes } from './adminPushNotifications.js';
import { normalizeGeoText, resolveSedesPermitidasPorScope } from './adminTerritorialScope.js';
import { createWhatsappMetaSender, createSupabaseWhatsappRepository, createWhatsappCloudService,
  environmentWhatsappAccessTokenResolver, whatsappMaxSendAttemptsFromEnv,
  registerWhatsappCloudRoutes } from './whatsappCloud.js';
import { ACTIVE_ACCOUNT_DELETION_STATUSES, parseAccountDeletionRequestBody,
  buildAccountDeletionAcceptedResponse } from './accountDeletionRequest.js';

export function createReleaseScopeResolver({ supabaseAdmin, getAuthenticatedUser }) {
  return async (req) => {
    const auth = await getAuthenticatedUser(req);
    if (!auth.user?.id) return null;
    const row = await resolveStoredRoleForVerifiedUser(supabaseAdmin, auth.user);
    if (!row) return { rol: 'jugador', authUserId: auth.user.id, alcance: 'none' };
    const rol = String(row.role || '').trim().toLowerCase();
    const allowed = {
      super_admin: ['global'], admin_nacional: ['pais', 'provincia', 'ciudad', 'sede'],
      admin_cadena: ['organizacion'], admin_club: ['sede'], empleado: ['sede'], editor_contenido: [],
    };
    const defaults = { super_admin: 'global', admin_nacional: 'pais', admin_club: 'sede' };
    const candidate = row.alcance || defaults[rol];
    const alcance = allowed[rol]?.includes(candidate) ? candidate : 'none';
    return { rol, alcance, superA: rol === 'super_admin' && alcance === 'global',
      authUserId: auth.user.id, authEmail: auth.user.email || '', email: auth.user.email || '', row,
      sedeId: row.sede_id == null ? null : Number(row.sede_id), organizacionId: row.organizacion_id || null,
      pais: row.pais, provincia: row.provincia, ciudad: row.ciudad,
      paisNorm: normalizeGeoText(row.pais), provinciaNorm: normalizeGeoText(row.provincia), ciudadNorm: normalizeGeoText(row.ciudad) };
  };
}

export function createAccountDeletionHandler({ supabaseAdmin, getAuthenticatedUser }) {
  return async (req, res) => {
    try {
    const auth = await getAuthenticatedUser(req);
    if (!auth.user) return res.status(auth.status || 401).json({ error: auth.error || 'No autorizado' });
    const parsed = parseAccountDeletionRequestBody(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error, code: parsed.code });
    const { data: existing, error: existingError } = await supabaseAdmin.from('solicitudes_eliminacion_cuenta')
      .select('id, estado, solicitado_at').eq('user_id', auth.user.id)
      .in('estado', ACTIVE_ACCOUNT_DELETION_STATUSES).order('solicitado_at', { ascending: false }).limit(1).maybeSingle();
    if (existingError) return res.status(503).json({ error: 'No se pudo comprobar la solicitud de eliminación.' });
    if (existing) return res.status(202).json(buildAccountDeletionAcceptedResponse(existing, { idempotent: true }));
    const { data, error } = await supabaseAdmin.from('solicitudes_eliminacion_cuenta')
      .insert({ user_id: auth.user.id, evidencia: parsed.evidence }).select('id, estado, solicitado_at').single();
    if (error) return res.status(503).json({ error: 'No se pudo registrar la solicitud de eliminación.' });
    return res.status(202).json(buildAccountDeletionAcceptedResponse(data));
    } catch { return res.status(503).json({ error: "No se pudo registrar la solicitud de eliminación." }); }
  };
}

export function mountReleaseRoutes(app, { supabaseAdmin, getAuthenticatedUser, serviceRoleConfigured, runtime, cron, pgPool = null }) {
  app.use('/api/push-tokens', pushTokensRateLimit);
  app.use('/api/push/send', pushSendRateLimit);
  app.use('/api/push/send-admin', pushSendRateLimit);
  const authUserFromBearer = async (req) => (await getAuthenticatedUser(req)).user || null;
  mountAliasAvailabilityRoute(app, { supabaseAdmin, authUserFromBearer });
  const adminListScopeFromRequest = createReleaseScopeResolver({ supabaseAdmin, getAuthenticatedUser });
  const sedesPermitidasPorScope = (scope) => resolveSedesPermitidasPorScope(supabaseAdmin, scope);
  const pushService = createMobilePushService({ supabaseAdmin, serviceRoleConfigured,
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '', sendEnabled: runtime.pushSendEnabled });
  const bridge = createLegacyPushBridge({ supabaseAdmin, pushService, runtime });
  configureMobilePushBridge(bridge);
  mountLegacyPushBridgeRoute(app, { bridge, adminListScopeFromRequest, sedesPermitidasPorScope, supabaseAdmin });
  const assertSuperAdminReq = async (req) => {
    const scope = await adminListScopeFromRequest(req);
    if (!scope?.superA) throw Object.assign(new Error('No autorizado'), { status: scope ? 403 : 401 });
    return scope;
  };
  mountCommercialReleaseRoutes(app, { supabaseAdmin, runtime, authUserFromBearer, assertSuperAdminReq,
    adminListScopeFromRequest, sedesPermitidasPorScope });
  registerFipaDocumentLibraryRoutes(app, { supabaseAdmin, serviceRoleConfigured, authUserFromBearer });
  registerMobilePushRoutes(app, { pushService, authUserFromBearer });
  registerAdminPushRoutes(app, { supabase: supabaseAdmin, pushService, authUserFromBearer,
    adminListScopeFromRequest, sedesPermitidasPorScope });

  const whatsappEnabled = runtime.outboundDeliveryEnabled && process.env.WHATSAPP_CLOUD_SEND_ENABLED === 'true';
  const whatsappService = serviceRoleConfigured ? createWhatsappCloudService({
    repository: createSupabaseWhatsappRepository(supabaseAdmin),
    sender: createWhatsappMetaSender({ graphVersion: process.env.WHATSAPP_META_GRAPH_VERSION,
      resolveAccessToken: environmentWhatsappAccessTokenResolver(process.env) }),
    sendEnabled: whatsappEnabled, maxSendAttempts: whatsappMaxSendAttemptsFromEnv(process.env),
  }) : null;
  registerWhatsappCloudRoutes(app, { whatsappService, appSecret: process.env.WHATSAPP_META_APP_SECRET,
    verifyToken: process.env.WHATSAPP_META_VERIFY_TOKEN });
  let sweeping = false;
  cron.schedule('* * * * *', async () => {
    if (!whatsappEnabled || !whatsappService || sweeping) return;
    sweeping = true;
    try { await whatsappService.processPendingOutbox({ limit: 20 }); }
    catch (error) { console.warn('[whatsapp-cloud] sweep unavailable', { code: error?.code || 'WHATSAPP_CLOUD_UNAVAILABLE' }); }
    finally { sweeping = false; }
  });
  cron.schedule('*/5 * * * *', async () => {
    if (!runtime.pushSendEnabled || !serviceRoleConfigured) return;
    try { await pushService.processPendingReceipts(); }
    catch (error) { console.warn('[push] receipts unavailable', { code: error?.code || 'PUSH_STORAGE_UNAVAILABLE' }); }
  });
  app.get('/ready', async (_req, res) => {
    const result = await backendReadiness({ supabaseAdmin, serviceRoleConfigured, runtime });
    const sql = await backendSqlReadiness(pgPool);
    const readiness = { ...result, ready: result.ready && sql.ready, sqlReady: sql.ready,
      ...(!sql.ready ? { reason: sql.reason } : {}) };
    return res.status(readiness.ready ? 200 : 503).json(readiness);
  });
  app.get('/api/legal/elegibilidad', async (req, res) => {
    try {
    const auth = await getAuthenticatedUser(req);
    if (!auth.user) return res.status(auth.status || 401).json({ error: auth.error || 'No autorizado' });
    const { data, error } = await supabaseAdmin.from('cuentas_elegibilidad_legal')
      .select('franja_edad, estado, privacidad_reforzada, verificado_at').eq('user_id', auth.user.id).maybeSingle();
    if (error) return res.status(503).json({ error: 'El control de elegibilidad no está disponible.' });
    if (!data) return res.status(403).json({ error: 'La verificación de edad es obligatoria.', code: 'age_verification_required' });
    if (!['habilitada', 'habilitada_restringida'].includes(data.estado)) return res.status(403).json({ error: 'La cuenta no está habilitada.', code: 'account_not_eligible' });
    return res.json({ allowed: true, age_band: data.franja_edad, enhanced_privacy: data.privacidad_reforzada, verified_at: data.verificado_at });
    } catch { return res.status(503).json({ error: "El control de elegibilidad no está disponible." }); }
  });
  const accountDeletionHandler = createAccountDeletionHandler({ supabaseAdmin, getAuthenticatedUser });
  app.post('/api/legal/eliminacion/solicitudes', accountDeletionHandler);
  return { pushService, adminListScopeFromRequest, sedesPermitidasPorScope, accountDeletionHandler };
}
