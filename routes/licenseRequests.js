import { requireSuperAdminUser } from '../lib/authAccess.js';
import { licenseRequestsRateLimit } from '../lib/rateLimit.js';
import { formSubmissionToCrmIngest } from '../lib/crmInboundForm.js';
import crypto from 'node:crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_STATES = new Set(['pendiente', 'aprobada', 'rechazada']);
const WHATSAPP_FOLLOWUP_CONSENT_VERSION = 'whatsapp-followup-v1';
const WHATSAPP_FOLLOWUP_CONSENT_TEXT = 'Autorizo de forma opcional a Padbol a contactarme por WhatsApp exclusivamente para dar seguimiento a esta solicitud. Esta autorización no incluye comunicaciones de marketing y puedo revocarla.';

export function licenseRequestPayloadHash(data) {
  const stable = { ...data, whatsapp_followup_consent_at: data.whatsapp_followup_consent ? true : null };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function text(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

export function buildLicenseRequestPayload(body = {}) {
  const email = text(body.email, 254).toLowerCase();
  const clubNombre = text(body.club_nombre, 160);
  const responsableNombre = text(body.responsable_nombre, 160);
  const pais = text(body.pais, 100);
  const ciudad = text(body.ciudad, 120);
  const whatsappFollowupConsent = body.whatsapp_followup_consent === true;
  if (!EMAIL_RE.test(email)) return { error: 'Ingresá un email de contacto válido' };
  if (!clubNombre) return { error: 'El nombre del club es obligatorio' };
  if (!responsableNombre) return { error: 'El nombre de la persona responsable es obligatorio' };
  // La solicitud pública es solamente el inicio comercial. La ubicación y
  // los datos operativos se completan después, desde la configuración guiada
  // de la sede, una vez que el acceso y el plan estén definidos.

  return {
    data: {
      club_nombre: clubNombre,
      club_direccion: text(body.club_direccion, 240) || null,
      // La tabla histórica todavía exige estos campos. Conservamos una marca
      // explícita hasta que la sede los complete en el asistente guiado.
      pais: pais || 'Pendiente de completar',
      ciudad: ciudad || 'Pendiente de completar',
      provincia_estado: text(body.provincia_estado, 120) || null,
      club_telefono: text(body.club_telefono, 80) || null,
      club_email: text(body.club_email, 254).toLowerCase() || null,
      club_web: text(body.club_web, 300) || null,
      deportes_canchas: body.deportes_canchas && typeof body.deportes_canchas === 'object'
        ? body.deportes_canchas
        : {},
      responsable_nombre: responsableNombre,
      responsable_cargo: text(body.responsable_cargo, 120) || null,
      email,
      whatsapp: text(body.whatsapp, 80) || null,
      whatsapp_followup_consent: whatsappFollowupConsent,
      whatsapp_followup_consent_source: whatsappFollowupConsent
        ? text(body.whatsapp_followup_consent_source, 120) || 'web:solicitud_licencia'
        : null,
      whatsapp_followup_consent_version: whatsappFollowupConsent ? WHATSAPP_FOLLOWUP_CONSENT_VERSION : null,
      whatsapp_followup_consent_text: whatsappFollowupConsent ? WHATSAPP_FOLLOWUP_CONSENT_TEXT : null,
      whatsapp_followup_consent_at: whatsappFollowupConsent ? new Date().toISOString() : null,
      nombre_legal: text(body.nombre_legal, 200) || null,
      numero_fiscal: text(body.numero_fiscal, 100) || null,
      fiscal_misma_que_club: body.fiscal_misma_que_club !== false,
      direccion_fiscal: text(body.direccion_fiscal, 240) || null,
      pais_fiscal: text(body.pais_fiscal, 100) || null,
      mensaje: text(body.mensaje, 2000) || null,
      estado: 'pendiente',
      tipo_interes: 'pendiente_definicion',
    },
  };
}

function isMissingTable(error) {
  return error?.code === '42P01' || /solicitudes_licencia/i.test(String(error?.message || ''));
}

function sendStorageError(res, error, fallback) {
  if (isMissingTable(error)) {
    return res.status(503).json({
      error: 'El formulario todavía no está habilitado en el servidor',
      code: 'LICENSE_REQUESTS_NOT_CONFIGURED',
    });
  }
  return res.status(500).json({ error: fallback });
}

export function licenseRequestToCrmIngest(id, data = {}) {
  const location = [data.ciudad, data.provincia_estado, data.pais]
    .map((value) => text(value, 120))
    .filter((value) => value && value !== 'Pendiente de completar')
    .join(', ');
  const details = [
    text(data.mensaje, 2000),
    `Club u organización: ${text(data.club_nombre, 160)}`,
    location ? `Ubicación: ${location}` : null,
    text(data.responsable_cargo, 120) ? `Cargo: ${text(data.responsable_cargo, 120)}` : null,
  ].filter(Boolean).join('\n');

  return formSubmissionToCrmIngest({
    id,
    form: 'dev_padbol_contacto_business',
    email: data.email,
    phone: data.whatsapp || data.club_telefono,
    name: data.responsable_nombre,
    subject: `Solicitud comercial desde dev.padbol.com — ${text(data.club_nombre, 160)}`,
    message: details,
  });
}

async function ingestLicenseRequestInCrm(crmService, id, data) {
  if (!crmService?.ingestInbound) return;
  const ingest = licenseRequestToCrmIngest(id, data);
  if (!ingest) return;
  try {
    await crmService.ingestInbound(ingest);
  } catch (error) {
    // La solicitud comercial ya quedó guardada. Una falla del CRM no debe
    // hacer que el visitante repita el formulario ni crear duplicados.
    console.error('[crm-form] no se pudo incorporar solicitud de licencia:', error?.message || error);
  }
}

export function mountLicenseRequestRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
  crmService = null,
}) {
  const adminDeps = {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  app.post('/api/solicitudes-licencia', licenseRequestsRateLimit, async (req, res) => {
    try {
      const parsed = buildLicenseRequestPayload(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const rawIdempotencyKey = String(req.headers['idempotency-key'] || '').trim();
      if (rawIdempotencyKey && (rawIdempotencyKey.length < 8 || rawIdempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(rawIdempotencyKey))) {
        return res.status(400).json({ error: 'Idempotency-Key inválido' });
      }
      const idempotencyKey = rawIdempotencyKey
        ? crypto.createHash('sha256').update(rawIdempotencyKey).digest('hex')
        : null;
      if (idempotencyKey) {
        parsed.data.idempotency_key = idempotencyKey;
        parsed.data.idempotency_payload_hash = licenseRequestPayloadHash(parsed.data);
      }
      const { data, error } = await supabaseAdmin
        .from('solicitudes_licencia')
        .insert(parsed.data)
        .select('id, estado, created_at')
        .single();
      if (error?.code === '23505' && idempotencyKey) {
        const existing = await supabaseAdmin.from('solicitudes_licencia')
          .select('id, estado, created_at, idempotency_payload_hash').eq('idempotency_key', idempotencyKey).maybeSingle();
        if (!existing.error && existing.data) {
          if (existing.data.idempotency_payload_hash !== parsed.data.idempotency_payload_hash) {
            return res.status(409).json({ error: 'Idempotency-Key ya utilizado con otra solicitud', code: 'IDEMPOTENCY_KEY_REUSED' });
          }
          await ingestLicenseRequestInCrm(crmService, existing.data.id, parsed.data);
          const { idempotency_payload_hash: _privateHash, ...response } = existing.data;
          return res.status(200).json({ ...response, idempotent: true });
        }
      }
      if (error) return sendStorageError(res, error, 'No se pudo enviar la solicitud');
      await ingestLicenseRequestInCrm(crmService, data.id, parsed.data);
      return res.status(201).json(data);
    } catch (error) {
      console.error('❌ POST /api/solicitudes-licencia:', error.message);
      return res.status(500).json({ error: 'No se pudo enviar la solicitud' });
    }
  });

  app.get('/api/admin/solicitudes-licencia', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const requestedState = text(req.query.estado, 20).toLowerCase();
      let query = supabaseAdmin.from('solicitudes_licencia').select('*').order('created_at', { ascending: false });
      if (ALLOWED_STATES.has(requestedState)) query = query.eq('estado', requestedState);
      const { data, error } = await query;
      if (error) return sendStorageError(res, error, 'No se pudieron cargar las solicitudes');
      return res.json(data || []);
    } catch (error) {
      console.error('❌ GET /api/admin/solicitudes-licencia:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar las solicitudes' });
    }
  });

  app.post('/api/admin/solicitudes-licencia/:id/rechazar', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const { data, error } = await supabaseAdmin
        .from('solicitudes_licencia')
        .update({ estado: 'rechazada', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('*')
        .maybeSingle();
      if (error) return sendStorageError(res, error, 'No se pudo rechazar la solicitud');
      if (!data) return res.status(404).json({ error: 'Solicitud no encontrada' });
      return res.json(data);
    } catch (error) {
      console.error('❌ POST rechazo solicitud licencia:', error.message);
      return res.status(500).json({ error: 'No se pudo rechazar la solicitud' });
    }
  });

  app.post('/api/admin/solicitudes-licencia/:id/tipo-interes', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const tipoInteres = text(req.body?.tipo_interes, 120);
      if (!tipoInteres) return res.status(400).json({ error: 'tipo_interes es obligatorio' });
      const { data, error } = await supabaseAdmin
        .from('solicitudes_licencia')
        .update({ tipo_interes: tipoInteres, estado: 'aprobada', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('*')
        .maybeSingle();
      if (error) return sendStorageError(res, error, 'No se pudo aprobar la solicitud');
      if (!data) return res.status(404).json({ error: 'Solicitud no encontrada' });
      return res.json(data);
    } catch (error) {
      console.error('❌ POST tipo interés solicitud licencia:', error.message);
      return res.status(500).json({ error: 'No se pudo aprobar la solicitud' });
    }
  });
}
