import crypto from 'node:crypto';
import { verifySpaceUploadToken } from './crmSpaceUploadToken.js';
import { normalizeEmail, normalizePhone } from './crmContact.js';
import { simulationDetailNotes } from './crmSimulationDetails.js';
import { createSimulationSnapshot } from './crmSimulationSnapshot.js';
import { sanitizeSpaceFile } from './crmSpacePrivacy.js';
import multer from 'multer';
import { emailEventToCrmIngest } from './crmInboundEmail.js';
import { formSubmissionToCrmIngest } from './crmInboundForm.js';
import { applyProspectReply } from './crmProspectReply.js';

function businessSimulationSummary(value, locale = 'es') {
  const read = (key, max = 1_000_000_000) => {
    const parsed = Number(value[key]);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
  };
  const courts = read('courts', 20), budget = read('budget'), reference = read('referencePerCourt', 1_000_000);
  if (courts === null || courts < 1 || !Number.isInteger(courts) || budget === null || reference === null) return '';
  const time = value => /^\d{2}:\d{2}$/.test(String(value || '')) ? String(value).split(':').reduce((total, part) => total * 60 + Number(part), 0) : NaN;
  const rows = Array.isArray(value.activities) ? value.activities.slice(0, 30) : [];
  const activities = rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const start = time(row.start), end = time(row.end), days = Number(row.days), rate = Number(row.rate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(days) || days < 0 || days > 31 || !Number.isFinite(rate) || rate < 0) return [];
    const hours = value.complementaryMode === 'monthly' && row.hours !== undefined ? Number(row.hours) : (end-start)/60;
    if (!Number.isFinite(hours) || hours <= 0 || (value.complementaryMode === 'monthly' && Math.abs(hours-(end-start)/60)>1/60)) return [];
    return [{ label: String(row.label || '').replace(/[<>]/g, '').trim().slice(0, 60), start, end, days, rate, hours }];
  });
  if (value.complementaryMode === 'monthly' && activities.length !== rows.length) return '';
  if (!activities.length && value.complementaryMode !== 'monthly') return '';
  const sorted = [...activities].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) if (sorted[index].start < sorted[index - 1].end) return '';
  const courtHours = activities.reduce((sum, item) => sum + item.hours * item.days * courts, 0);
  const courtRevenue = activities.reduce((sum, item) => sum + item.hours * item.days * item.rate * courts, 0);
  const complements = Array.isArray(value.complements) ? value.complements.slice(0, 12) : [];
  const complementCost = complements.reduce((sum, item) => sum + (Number.isFinite(Number(item?.budget)) && Number(item.budget) >= 0 ? Number(item.budget) : 0), 0);
  const investment = courts * reference + complementCost;
  const complementLabels = complements.filter(item => item && (item.budget !== null && item.budget !== undefined || item.pending)).map(item => String(item.label || '').replace(/[<>]/g, '').trim().slice(0, 40)).filter(Boolean).slice(0, 5).join(', ');
  const sources = Array.isArray(value.revenueSources) ? value.revenueSources.slice(0, 6).map(item => String(item).replace(/[<>]/g, '').trim()).filter(Boolean) : [];
  const agenda = activities.slice(0, 4).map(item => `${item.label || 'Actividad'} ${Math.floor(item.start / 60)}:${String(item.start % 60).padStart(2, '0')}–${Math.floor(item.end / 60)}:${String(item.end % 60).padStart(2, '0')} (${item.days}d)`).join(', ');
  const mode = ['percent', 'reservation', 'monthly'].includes(String(value.complementaryMode)) ? String(value.complementaryMode) : 'none';
  const percent = read('complementaryPercent', 1000) ?? 0;
  const reservations = read('complementaryReservations', 1_000_000) ?? 0;
  const spend = read('complementarySpend') ?? 0;
  const monthlyKeys = new Set(['classes','tournaments','leagues','buffet','merchandising','events','sponsorships','memberships','other']);
  const monthly = mode === 'monthly' ? value.simpleMonthlyRevenues : [];
  if (!Array.isArray(monthly) || monthly.length > 9) return '';
  const seen = new Set();
  for (const item of monthly) {
    if (!item || !monthlyKeys.has(item.key) || seen.has(item.key) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0 || item.amount > 1_000_000_000) return '';
    seen.add(item.key);
  }
  const costsProvided = mode === 'monthly' && value.monthlyOperatingCosts !== null && value.monthlyOperatingCosts !== undefined;
  const costs = costsProvided ? read('monthlyOperatingCosts') : null;
  if (costsProvided && costs === null) return '';
  const complementaryRevenue = mode === 'monthly' ? monthly.reduce((sum,item)=>sum+item.amount,0) : mode === 'percent' ? courtRevenue * percent / 100 : mode === 'reservation' ? reservations * spend : 0;
  const total = courtRevenue + complementaryRevenue;
  const denominator = costsProvided ? total - costs : total;
  let payback = investment > 0 && denominator > 0 ? investment / denominator : null;
  if (mode === 'monthly' && costsProvided && value.advertisingMaintenanceEnabled === true && investment > 0) {
    const beforeMaintenance = total - costs + 250;
    payback = beforeMaintenance > 0 && investment <= beforeMaintenance * 3 ? investment / beforeMaintenance : denominator > 0 ? 3 + (investment - beforeMaintenance * 3) / denominator : null;
  }
  const currency = ['USD','EUR','ARS','MXN','CLP'].includes(String(value.currency)) ? String(value.currency) : 'USD';
  const format = (amount, digits = 0) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-AR', { maximumFractionDigits: digits }).format(amount);
  if (mode === 'monthly') {
    const labels = monthly.map(item => `${String(item.label || item.key).replace(/[<>]/g,'').slice(0,80)}: ${currency} ${format(item.amount)}/mes`).join('; ');
    return locale === 'en'
      ? ` Internal calculation from user assumptions, not an offer: ${courts} courts; investment ${currency} ${format(investment)}; court rental revenue ${currency} ${format(courtRevenue)}/month; other monthly lines ${currency} ${format(complementaryRevenue)}; total revenue ${currency} ${format(total)}/month. ${costsProvided ? `Operating costs ${currency} ${format(costs)}/month; operating result ${currency} ${format(denominator)} before taxes and financing; indicative recovery ${payback ? format(payback,1)+' months' : 'not calculable'}.` : `Gross equivalence to investment ${payback ? format(payback,1)+' months' : 'not calculable'}; not profit or net recovery; costs not deducted.`} Monthly lines: ${labels}. Rental hours exclude separately estimated classes, tournaments and leagues. Schedule: ${agenda}.`
      : ` Simulación orientativa con datos del interesado, no es una oferta: ${courts} canchas; inversión ${currency} ${format(investment)}; alquileres ${currency} ${format(courtRevenue)}/mes; otras líneas ${currency} ${format(complementaryRevenue)}/mes; facturación total ${currency} ${format(total)}/mes. ${costsProvided ? `Gastos operativos ${currency} ${format(costs)}/mes; resultado operativo ${currency} ${format(denominator)} antes de impuestos y financiación; recuperación orientativa ${payback ? format(payback,1)+' meses' : 'no calculable'}.` : `Equivalencia bruta de la inversión ${payback ? format(payback,1)+' meses' : 'no calculable'}; no es ganancia ni recuperación neta; no descuenta gastos.`} Ingresos mensuales: ${labels}. Las horas de alquiler excluyen clases, torneos y ligas estimados aparte. Agenda: ${agenda}.`;
  }
  return locale === 'en'
    ? ` Commercial simulation (user-declared assumptions, indicative calculation, not an offer): budget ${currency} ${format(budget)}; ${courts} court(s); indicative investment ${currency} ${format(investment)}; ${format(courtHours, 1)} court-hours/month; court revenue ${currency} ${format(courtRevenue)}/month; complementary revenue ${currency} ${format(complementaryRevenue)}/month (revenue, not profit); total ${currency} ${format(total)}/month; theoretical gross recovery ${payback ? `${format(payback, 1)} months` : 'not calculable'}, before operating costs.${complementLabels ? ` Complements: ${complementLabels}.` : ''}${agenda ? ` Schedule: ${agenda}.` : ''}`
    : ` Simulación comercial (supuestos declarados por el interesado, cálculo orientativo, no es una oferta): presupuesto ${currency} ${format(budget)}; ${courts} cancha(s); inversión orientativa ${currency} ${format(investment)}; ${format(courtHours, 1)} horas-canchas/mes; facturación por canchas ${currency} ${format(courtRevenue)}/mes; facturación complementaria ${currency} ${format(complementaryRevenue)}/mes (facturación, no ganancia); total ${currency} ${format(total)}/mes; recuperación bruta teórica ${payback ? `${format(payback, 1)} meses` : 'no calculable'}, antes de gastos operativos.${complementLabels ? ` Complementos: ${complementLabels}.` : ''}${sources.length ? ` Líneas complementarias: ${sources.join(', ')}.` : ''}${agenda ? ` Agenda: ${agenda}.` : ''}`;
}

export function simulationSummary(value, locale = 'es') {
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'business-v2') return businessSimulationSummary(value, locale);

  const read = (key, min = 0, max = 1_000_000_000) => {
    const parsed = Number(value[key]);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
  };
  const courts = read('courts', 1, 20);
  const price = read('pricePerHour', 0.000001, 10_000_000);
  const hours = read('availableHours', 0.000001, 24);
  const days = read('operatingDays', 1, 31);
  const occupancy = read('occupancy', 0.000001, 100);
  if (courts === null || price === null || hours === null || days === null || occupancy === null) return '';
  const other = read('otherRevenue') ?? 0;
  const costs = read('operatingCosts') ?? 0;
  const investment = read('initialInvestment') ?? 0;
  const rental = courts * price * hours * days * (occupancy / 100);
  const total = rental + other;
  const operating = total - costs;
  const payback = investment > 0 && operating > 0 ? investment / operating : null;
  const currency = ['USD','EUR','ARS','MXN','CLP'].includes(String(value.currency)) ? String(value.currency) : 'USD';
  const scenario = ['conservative','base','optimistic'].includes(String(value.scenario)) ? String(value.scenario) : 'base';
  const scenarioLabel = locale === 'en' ? ({ conservative: 'conservative', base: 'base', optimistic: 'optimistic' })[scenario] : ({ conservative: 'conservador', base: 'intermedio', optimistic: 'optimista' })[scenario];
  const money = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-AR', { maximumFractionDigits: 0 }).format(Math.round(operating));
  const used = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-AR', { maximumFractionDigits: 1 }).format(occupancy);
  return locale === 'en'
    ? ` Indicative simulation (user-entered assumptions, not an offer): ${Math.round(courts)} court(s), ${used}% occupancy, monthly operating result ${currency} ${money}, simple payback ${payback ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(payback)} months` : 'not estimated'}, ${scenarioLabel} scenario.`
    : ` Simulación orientativa (supuestos declarados por el interesado, no es una oferta): ${Math.round(courts)} cancha(s), ocupación ${used}%, resultado operativo mensual ${currency} ${money}, recuperación simple ${payback ? `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(payback)} meses` : 'no estimada'}, escenario ${scenarioLabel}.`;
}
function inboundError(message, status = 400, code = 'CRM_INBOUND_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// Endpoint deliberadamente independiente del proveedor. El adaptador externo debe
// transformar el webhook a este contrato canónico después de validar a su proveedor.
const SPACE_BUCKET = 'crm-space-requests';
const spaceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 7 } });

const readySpacePools = new WeakSet();
// Migrations are a release prerequisite. Intake may inspect the schema, never repair it.
export async function ensureSpaceTable(pool) {
  if (pool && readySpacePools.has(pool)) return true;
  try {
    if (!pool?.query) throw new Error('SPACE_POOL_UNAVAILABLE');
    await pool.query(`select id,conversation_id,contact_id,status,length_m,width_m,covered,
      height_m,desired_courts,files,simulation_path,actor,created_at,updated_at,
      retention_expires_at,project_active_hold,project_hold_reason,project_hold_set_by,
      project_hold_set_at,media_deleted_at,metadata_policy
      from public.crm_space_requests limit 0`);
    readySpacePools.add(pool);
    return true;
  } catch {
    throw inboundError('El almacenamiento del espacio todavía no está disponible.',503,'SPACE_SCHEMA_NOT_READY');
  }
}

function imageExtension(mimetype, name = '') {
  if (mimetype === 'image/jpeg') return 'jpg';
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  if (mimetype === 'image/heic' || mimetype === 'image/heif') return 'heic';
  if (mimetype === 'application/pdf') return 'pdf';
  const ext = String(name).split('.').pop()?.toLowerCase();
  return ['jpg','jpeg','png','webp','heic','pdf'].includes(ext) ? ext : '';
}

function validFile(file) {
  const ext = imageExtension(file.mimetype, file.originalname);
  if (!ext) return false;
  const b = file.buffer;
  if (ext === 'jpg') return b?.[0] === 0xff && b?.[1] === 0xd8;
  if (ext === 'png') return b?.[0] === 0x89 && b?.[1] === 0x50 && b?.[2] === 0x4e && b?.[3] === 0x47;
  if (ext === 'webp') return b?.subarray(0, 4).toString() === 'RIFF' && b?.subarray(8, 12).toString() === 'WEBP';
  if (ext === 'pdf') return b?.subarray(0, 4).toString() === '%PDF';
  if (ext === 'heic') return b?.subarray(4, 8).toString() === 'ftyp';
  return false;
}

export function registerCrmInboundRoutes(app, {
  crmService,
  leadAnalyzer = null,
  emailInboundSecret = '',
  formInboundSecret = '',
  pool = null,
  db = null,
  onNewLead = null,
  onExperienceAction = null,
  logger = console,
} = {}) {
  if (!crmService) return;

  function requireInboundSecret(req, expectedSecret = emailInboundSecret) {
    if (!expectedSecret) {
      throw inboundError('La recepción CRM no está configurada.', 503, 'CRM_INBOUND_NOT_CONFIGURED');
    }
    const auth = String(req.headers.authorization || '');
    const supplied = auth.replace(/^Bearer\s+/i, '').trim();
    if (!sameSecret(supplied, expectedSecret)) {
      throw inboundError('No autorizado.', 401, 'CRM_INBOUND_UNAUTHENTICATED');
    }
  }

  function reject(res, error, source) {
    logger?.warn?.(`[crm-inbound-${source}] rejected`, { code: error?.code || 'CRM_INBOUND_UNAVAILABLE' });
    return res.status(Number(error?.status) || 503).json({
      error: error?.message || 'No disponible.',
      code: error?.code || 'CRM_INBOUND_UNAVAILABLE',
    });
  }

  async function eligibleConversation(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
    if (!pool?.query) throw inboundError('No se pudo verificar la consulta.',503,'CRM_SCOPE_UNAVAILABLE');
    const result=await pool.query("select c.id from public.crm_conversations c left join public.crm_commercial_form_cases f on f.conversation_id=c.id where c.id=$1 and c.test_hidden_at is null and c.email_return_linked_to is null and public.crm_commercial_form_is_allowed(c.id) and coalesce(f.progress_state,c.estado)<>'cerrado'",[id]);
    return result.rows?.[0] ? crmService.getConversation(id) : null;
  }
  app.post('/api/inbound/crm/email', async (req, res) => {
    try {
      requireInboundSecret(req);
      const ingest = emailEventToCrmIngest(req.body);
      if (!ingest) throw inboundError('Evento de correo inválido.');
      const result = await crmService.ingestInbound(ingest);
      if (db && typeof applyProspectReply === 'function') await applyProspectReply(db, { email: req.body?.from || req.body?.sender || req.body?.email, text: req.body?.body || req.body?.text || req.body?.subject || '', source: 'email' }).catch(() => null);
      if (result.status === 'accepted' && typeof onNewLead === 'function') queueMicrotask(() => Promise.resolve(onNewLead({ conversation: result.conversation, caseType: 'email' })).catch(() => {}));
      if (result.status === 'accepted' && typeof leadAnalyzer === 'function') {
        queueMicrotask(() => leadAnalyzer({ ingest, conversation: result.conversation }).catch((error) => {
          logger?.error?.('[crm-lead-analysis] failed', { code: error?.message || 'CRM_LEAD_ANALYSIS_FAILED' });
        }));
      }
      return res.status(result.status === 'accepted' ? 201 : 200).json({
        ok: true,
        status: result.status,
        conversationId: result.conversation?.id || null,
      });
    } catch (error) { return reject(res, error, 'email'); }
  });

  app.post('/api/inbound/crm/form', async (req, res) => {
    try {
      // Dedicated form credentials do not authorize email or analysis intake.
      // Legacy form senders remain compatible only when no dedicated key is configured.
      requireInboundSecret(req, formInboundSecret || emailInboundSecret);
      const ingest = formSubmissionToCrmIngest(req.body);
      if (!ingest) throw inboundError('Formulario inválido.');
      ingest.qualificationData.lead_analysis_request.status = typeof leadAnalyzer === 'function' ? 'pending' : 'disabled';
      const result = await crmService.ingestInbound(ingest);
      if (result.status === 'accepted' && typeof onNewLead === 'function' && ingest.qualificationData?.routing?.workflow === 'commercial_lead') queueMicrotask(() => Promise.resolve(onNewLead({ conversation: result.conversation, caseType: 'form' })).catch(() => {}));
      if (result.status === 'accepted' && typeof leadAnalyzer === 'function') {
        queueMicrotask(() => leadAnalyzer({ ingest, conversation: result.conversation }).catch((error) => {
          logger?.error?.('[crm-lead-analysis] failed', { code: error?.message || 'CRM_LEAD_ANALYSIS_FAILED' });
        }));
      }
      return res.status(result.status === 'accepted' ? 201 : 200).json({
        ok: true,
        status: result.status,
        conversationId: result.conversation?.id || null,
      });
    } catch (error) { return reject(res, error, 'form'); }
  });

  // Contact details identify the submitter, never a forwarded invitation alone.
  // This only resolves intake; it grants no access to CRM records or private media.
  app.post('/api/inbound/crm/experience/contact', async (req, res) => {
    try {
      requireInboundSecret(req, formInboundSecret || emailInboundSecret);
      const name = String(req.body?.name || '').trim().slice(0,160);
      const email = normalizeEmail(req.body?.email);
      const phone = normalizePhone(req.body?.phone);
      if (!name || !email || !phone) throw inboundError('Completa nombre, correo y WhatsApp.');
      const resolved = await crmService.findOrCreateContact({ nombre:name, email, phone });
      if (resolved.ambiguous) throw inboundError('El equipo debe revisar los datos de contacto.',409,'CONTACT_REVIEW_REQUIRED');
      const contact = resolved.contact;
      const bothMatch = contact.email_normalized === email && contact.phone_normalized === phone;
      // Legacy contacts can lack a normalized phone. Reuse only the same
      // contact's eligible enquiry when BOTH original submitted identities match.
      // An email match alone never supplies or updates a missing contact phone.
      const matchesContactIdentity = conversation => {
        if (!conversation || conversation.contact_id !== contact.id) return false;
        if (bothMatch) return true;
        const fields = conversation.qualification_data?.form_submission?.fields;
        return typeof fields?.Email === 'string' && typeof fields?.WhatsApp === 'string'
          && normalizeEmail(fields.Email) === email && normalizePhone(fields.WhatsApp) === phone;
      };
      const previousId = String(req.body?.conversationId || '');
      const previous = await eligibleConversation(previousId);
      let conversation = matchesContactIdentity(previous) ? previous : null;
      if (!conversation && pool?.query) {
        const found = await pool.query("select c.id from public.crm_conversations c left join public.crm_commercial_form_cases f on f.conversation_id=c.id where c.contact_id=$1 and c.test_hidden_at is null and c.email_return_linked_to is null and crm_commercial_form_is_allowed(c.id) and coalesce(f.progress_state,c.estado)<>'cerrado' order by c.created_at desc limit 10",[contact.id]);
        for (const candidate of (found.rows || []).slice(0,10)) {
          const eligible = await eligibleConversation(candidate.id);
          if (matchesContactIdentity(eligible)) { conversation = eligible; break; }
        }
      }
      if (!conversation) {
        const ingest = formSubmissionToCrmIngest({ id:crypto.randomUUID(), form:'Consulta Padbol · Otra consulta', name, email, phone, message:'Solicitud desde la experiencia comercial. Datos de contacto declarados por el visitante; no verificados.', fields:{ Nombre:name, Email:email, WhatsApp:phone }, workflow:'commercial_lead' });
        if (!ingest) throw inboundError('No se pudo registrar la consulta.');
        const result = await crmService.ingestInbound(ingest);
        conversation = result.conversation;
      }
      if (!conversation?.id) throw inboundError('No se pudo asociar la consulta.',503);
      if (!pool?.query) throw inboundError('No se pudo asignar la consulta.',503);
      await pool.query("insert into public.crm_commercial_form_cases(conversation_id,assigned_user_id,progress_state,commercial_next_step) select $1,u.id,'nuevo','Revisar proyecto y contactar por el medio elegido' from auth.users u where lower(u.email)='sm@padbol.com' on conflict(conversation_id) do nothing",[conversation.id]);
      // Request-only permission: deliberately separate from marketing / welcome consent.
      const permission = { preferredChannel:['email','whatsapp','phone','video'].includes(req.body?.preferredContact) ? req.body.preferredContact : 'email', accepted:req.body?.preferredContact === 'whatsapp' && req.body?.whatsappConsent === true, scope:'respond_to_this_request', phone, email, textVersion:'experience-whatsapp-request-v1', text:'Autorizo a Padbol a contactarme por WhatsApp para atender esta solicitud.', recordedAt:new Date().toISOString(), source:'commercial_experience_contact_form', identityVerified:false };
      if (!pool?.query) throw inboundError('No se pudo guardar la preferencia de contacto.',503,'CONTACT_PERMISSION_STORAGE_UNAVAILABLE');
      const stored = await pool.query("update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{experience_contact_permission}',$2::jsonb,true),updated_at=now() where id=$1 returning id",[conversation.id,JSON.stringify(permission)]);
      if (!stored.rows?.[0]) throw inboundError('No se pudo guardar la preferencia de contacto.',503,'CONTACT_PERMISSION_STORAGE_UNAVAILABLE');
      await crmService.createActivity({contact_id:conversation.contact_id || contact.id,conversation_id:conversation.id,activity_type:'note',author:'experiencia-comercial',summary:permission.accepted ? 'El visitante autorizó el contacto por WhatsApp para atender esta solicitud. No autoriza campañas publicitarias.' : `Medio de contacto elegido: ${{email:'correo electrónico',phone:'llamada telefónica',video:'videollamada',whatsapp:'WhatsApp'}[permission.preferredChannel]}. Sin autorización de WhatsApp para esta solicitud. No autoriza campañas publicitarias.`});
      return res.json({ ok:true, conversationId:conversation.id });
    } catch(error) { return reject(res,error,'experience-contact'); }
  });

  app.post('/api/inbound/crm/experience', async (req, res) => {
    try {
      requireInboundSecret(req, formInboundSecret || emailInboundSecret);
      const conversationId = String(req.body?.conversationId || '').trim();
      const action = String(req.body?.action || '').trim();
      const locale = String(req.body?.locale || 'es').toLowerCase() === 'en' ? 'en' : 'es';
      const contactMode = ['phone', 'video'].includes(String(req.body?.contactMode)) ? String(req.body.contactMode) : '';
      const preferredTime = String(req.body?.preferredTime || '').trim().slice(0, 120);
      if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !['proposal', 'advisor'].includes(action)) {
        throw inboundError('Solicitud de experiencia inválida.');
      }
      const conversation = await eligibleConversation(conversationId);
      if (!conversation?.id) throw inboundError('Consulta no encontrada.', 404, 'CRM_EXPERIENCE_NOT_FOUND');
      const contactDetail = action === 'advisor' && contactMode
        ? (locale === 'en' ? ` Preferred channel: ${contactMode === 'phone' ? 'phone call' : 'video call'}.${preferredTime ? ` Requested time: ${preferredTime}.` : ''}` : ` Canal preferido: ${contactMode === 'phone' ? 'llamada telefónica' : 'videollamada'}.${preferredTime ? ` Horario solicitado: ${preferredTime}.` : ''}`)
        : '';
      const summary = (action === 'proposal'
        ? (locale === 'en' ? 'Quote requested for the project from the interactive Padbol experience.' : 'Solicitud de cotización para el proyecto desde la experiencia interactiva Padbol.')
        : (locale === 'en' ? 'Advisor conversation requested from the interactive Padbol experience.' : 'Solicitud de conversación con asesor desde la experiencia interactiva Padbol.')) + contactDetail + simulationSummary(req.body?.simulation, locale);
      const baseSummary = action === 'proposal'
        ? (locale === 'en' ? 'Quote requested for the project from the interactive Padbol experience.' : 'Solicitud de cotización para el proyecto desde la experiencia interactiva Padbol.')
        : (locale === 'en' ? 'Advisor conversation requested from the interactive Padbol experience.' : 'Solicitud de conversación con asesor desde la experiencia interactiva Padbol.');
      const snapshot = createSimulationSnapshot(req.body?.simulation);
      if (req.body?.simulation?.type === 'business-v2' && req.body.simulation.complementaryMode === 'monthly' && !snapshot) throw inboundError('Revisa los datos de la simulación.',400,'INVALID_SIMULATION');
      const detailNotes = !snapshot && simulationSummary(req.body?.simulation, locale) ? simulationDetailNotes(req.body?.simulation) : [];
      const recent = typeof crmService.listActivities === 'function' ? await crmService.listActivities(conversation.id).catch(() => []) : [];
      const duplicate = (recent || []).find(item => item.author === 'experiencia-comercial' && String(item.summary || '').startsWith(baseSummary) && Date.now() - new Date(item.created_at).getTime() < 15 * 60 * 1000);
      if (duplicate && (!snapshot || snapshot.fingerprint === conversation.qualification_data?.commercial_simulation?.fingerprint)) return res.status(200).json({ ok: true, activityId: duplicate.id, conversationId: conversation.id, assignedTo: 'Nicolás Renedo', duplicate: true });
      if (snapshot) {
        if (!pool?.query) throw inboundError('No se pudo guardar el proyecto estructurado.',503,'CRM_SIMULATION_STORAGE_UNAVAILABLE');
        const saved = await pool.query("update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{commercial_simulation}',$2::jsonb,true),updated_at=now() where id=$1 returning id",[conversation.id,JSON.stringify(snapshot)]);
        if (!saved.rows?.[0]) throw inboundError('No se pudo guardar el proyecto.',503,'CRM_SIMULATION_STORAGE_UNAVAILABLE');
      }
      const nextStep = action === 'proposal' ? 'Nicolás Renedo · preparar cotización personalizada' : `Nicolás Renedo · coordinar ${contactMode === 'video' ? 'videollamada' : 'llamada'} con el interesado`;
      const payload = { contact_id: conversation.contact_id, conversation_id: conversation.id, activity_type: 'note', summary: snapshot ? `Simulación del proyecto actualizada: ${snapshot.courts} canchas. Inversión ${snapshot.currency} ${snapshot.financials.investment.toLocaleString('es-AR')}; facturación mensual ${snapshot.currency} ${snapshot.financials.totalRevenue.toLocaleString('es-AR')}. Ver el panel Proyecto para revisar los datos completos.` : summary.slice(0, 1900), next_step: nextStep, follow_up_at: null, author: 'experiencia-comercial' };
      let activity;
      try { activity = await crmService.createActivity(payload); }
      catch { const { next_step, ...fallback } = payload; activity = await crmService.createActivity(fallback); }
      for (const detail of detailNotes) {
        await crmService.createActivity({ contact_id: conversation.contact_id, conversation_id: conversation.id, activity_type: 'note', summary: detail, author: 'experiencia-comercial' });
      }
      if (!['cerrado', 'closed'].includes(String(conversation.estado || '').toLowerCase())) {
        await crmService.markHandoff({ conversationId: conversation.id, operador: 'Nicolás Renedo' }).catch(error => logger?.warn?.('[crm-experience] handoff failed', { code: error?.code || 'HANDOFF_FAILED' }));
      }
      if (typeof onExperienceAction === 'function') queueMicrotask(() => Promise.resolve(onExperienceAction({ conversation, action, contactMode, preferredTime })).catch(() => {}));
      return res.status(201).json({ ok: true, activityId: activity?.id || null, conversationId: conversation.id, assignedTo: 'Nicolás Renedo' });
    } catch (error) { return reject(res, error, 'experience'); }
  });

  app.post('/api/inbound/crm/space-request', async (req, res, next) => {
    try {
      if (req.headers['x-padbol-space-token']) {
        req.spaceUploadClaims=verifySpaceUploadToken({token:req.headers['x-padbol-space-token'],secret:formInboundSecret || emailInboundSecret,conversationId:req.headers['x-padbol-space-conversation']});
      } else requireInboundSecret(req, formInboundSecret || emailInboundSecret);
      next();
    } catch (error) { reject(res, error, 'space-auth'); }
  }, spaceUpload.fields([{ name: 'photos', maxCount: 6 }, { name: 'plan', maxCount: 1 }]), async (req, res) => {
    try {
      if (!db?.storage || !pool?.query) throw inboundError('El almacenamiento privado no está disponible.', 503, 'SPACE_STORAGE_UNAVAILABLE');
      const conversationId = String(req.body?.conversationId || '').trim();
      if (req.spaceUploadClaims && req.spaceUploadClaims.conversationId!==conversationId) throw inboundError('Carga inválida.',401,'SPACE_UPLOAD_TOKEN_INVALID');
      if (String(req.body?.consent) !== 'true') throw inboundError('La autorización de uso de imágenes es obligatoria.', 400, 'SPACE_CONSENT_REQUIRED');
      if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw inboundError('Consulta inválida.', 400, 'SPACE_INVALID');
      const conversation = await eligibleConversation(conversationId);
      if (!conversation?.id) throw inboundError('Consulta no encontrada.', 404, 'SPACE_NOT_FOUND');
      const length = Number(req.body?.lengthM), width = Number(req.body?.widthM);
      if (!Number.isFinite(length) || !Number.isFinite(width) || length < 1 || width < 1 || length > 500 || width > 500) throw inboundError('Indicá medidas válidas.', 400, 'SPACE_INVALID_DIMENSIONS');
      const covered = String(req.body?.covered) === 'true';
      const height = covered ? Number(req.body?.heightM) : null;
      if (covered && (!Number.isFinite(height) || height < 5.5 || height > 30)) throw inboundError('Indicá una altura válida.', 400, 'SPACE_INVALID_HEIGHT');
      const desiredCourts = req.body?.desiredCourts ? Number(req.body.desiredCourts) : null;
      if (desiredCourts !== null && (!Number.isInteger(desiredCourts) || desiredCourts < 1 || desiredCourts > 20)) throw inboundError('Cantidad de canchas inválida.', 400, 'SPACE_INVALID_COURTS');
      const shape=String(req.body?.spaceShape || 'rectangular');
      if (!['rectangular','l-shaped','irregular'].includes(shape)) throw inboundError('Forma del espacio inválida.',400,'SPACE_INVALID_SHAPE');
      const capacity=Math.max(Math.floor(length/10)*Math.floor(width/8),Math.floor(length/8)*Math.floor(width/10));
      if (desiredCourts!==null && desiredCourts>capacity) throw inboundError('La cantidad supera la distribución orientativa del espacio.',400,'SPACE_COURT_COUNT_EXCEEDS_REGULAR_LAYOUT');
      const photos = req.files?.photos || [], plan = req.files?.plan?.[0] ? [req.files.plan[0]] : [];
      const all = [...photos, ...plan];
      if (shape!=='rectangular' && !plan.length) throw inboundError('Adjunta un croquis para este espacio.',400,'SPACE_PLAN_REQUIRED');
      if (!photos.length) throw inboundError('Adjuntá al menos una fotografía.', 400, 'SPACE_PHOTOS_REQUIRED');
      if (photos.length > 6 || plan.length > 1) throw inboundError('Demasiados archivos.', 400, 'SPACE_TOO_MANY_FILES');
      if (!all.every(validFile)) throw inboundError('Formato de archivo no permitido. Usá JPG, PNG, WEBP, HEIC o PDF.', 400, 'SPACE_INVALID_FILE');
      if (all.reduce((total, file) => total + file.size, 0) > 40 * 1024 * 1024) throw inboundError('El envío supera 40 MB.', 413, 'SPACE_FILES_TOO_LARGE');
      // Validate and sanitize every image before any upload. No original-photo fallback.
      const sanitized = [];
      for (const [index, file] of all.entries()) sanitized.push(await sanitizeSpaceFile(file, { kind: index < photos.length ? 'photo' : 'plan' }));
      if (sanitized.reduce((total, file) => total + file.buffer.length, 0) > 40 * 1024 * 1024) throw inboundError('Las imágenes procesadas superan 40 MB. Reduce su tamaño.', 413, 'SPACE_FILES_TOO_LARGE');
      await ensureSpaceTable(pool);
      const { error: bucketError } = await db.storage.createBucket(SPACE_BUCKET, { public: false });
      if (bucketError && !/already exists|duplicate/i.test(String(bucketError.message || ''))) throw bucketError;
      const stored = [];
      for (const [index, file] of sanitized.entries()) {
        const ext = file.extension;
        const path = `${conversation.id}/${Date.now()}-${index}-${crypto.randomUUID()}.${ext}`;
        const { error } = await db.storage.from(SPACE_BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
        if (error) throw error;
        stored.push({ path, name: `${index < photos.length ? 'foto' : 'plano'}-${index + 1}.${ext}`, type: file.mimetype, size: file.buffer.length, kind: index < photos.length ? 'photo' : 'plan', metadataStripped: file.metadataStripped });
      }
      const { rows } = await pool.query(`insert into public.crm_space_requests (conversation_id, contact_id, length_m, width_m, covered, height_m, desired_courts, files, actor, metadata_policy) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'raster-stripped-v1') returning id, status`, [conversation.id, conversation.contact_id || null, length, width, covered, height, desiredCourts, JSON.stringify(stored), 'web']);
      const request = rows?.[0];
      await pool.query("update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{space}',coalesce(qualification_data->'space','{}'::jsonb)||$2::jsonb,true) where id=$1",[conversation.id,JSON.stringify({shape,lengthM:length,widthM:width,covered,heightM:height,desiredCourts,requestId:request.id})]);
      const summary = (locale) => `Solicitud de visualización del espacio recibida. Medidas: ${length} × ${width} m${covered ? `, cubierto, altura ${height} m` : ', sin altura declarada'}. Canchas deseadas: ${desiredCourts || 'a definir'}. Archivos privados: ${stored.length}. Estado: recibida.`;
      const activity = await crmService.createActivity({ contact_id: conversation.contact_id, conversation_id: conversation.id, activity_type: 'note', summary: summary(), next_step: 'Nicolás Renedo · revisar espacio y preparar simulación visual', follow_up_at: null, author: 'experiencia-comercial' });
      if (!['cerrado', 'closed'].includes(String(conversation.estado || '').toLowerCase())) await crmService.markHandoff({ conversationId: conversation.id, operador: 'Nicolás Renedo' }).catch(() => {});
      if (typeof onExperienceAction === 'function') queueMicrotask(() => Promise.resolve(onExperienceAction({ conversation, action: 'space', contactMode: '', preferredTime: '' })).catch(() => {}));
      return res.status(201).json({ ok: true, requestId: request?.id || null, status: request?.status || 'recibida', activityId: activity?.id || null, files: stored.length });
    } catch (error) { return reject(res, error, 'space-request'); }
  });

  app.post('/api/inbound/crm/prospect-reply' , async (req, res) => {
    try {
      requireInboundSecret(req, formInboundSecret || emailInboundSecret);
      if (!db) throw inboundError('CRM de prospectos no disponible.', 503, 'PROSPECT_REPLY_UNAVAILABLE');
      const result = await applyProspectReply(db, { email: req.body?.email, text: req.body?.text || req.body?.body || '', source: 'prospect-email' });
      if (!result) throw inboundError('Prospecto no encontrado.', 404, 'PROSPECT_REPLY_NOT_FOUND');
      return res.status(200).json({ ok: true, ...result });
    } catch (error) { return reject(res, error, 'prospect-reply'); }
  });

  app.post('/api/inbound/crm/analysis', async (req, res) => {
    try {
      requireInboundSecret(req);
      const result = await crmService.attachLeadAnalysis(req.body || {});
      return res.status(result.status === 'accepted' ? 201 : 200).json({
        ok: true,
        status: result.status,
        conversationId: result.conversation?.id || null,
      });
    } catch (error) { return reject(res, error, 'analysis'); }
  });
}
