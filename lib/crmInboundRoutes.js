import crypto from 'node:crypto';
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
    return [{ label: String(row.label || '').replace(/[<>]/g, '').trim().slice(0, 60), start, end, days, rate }];
  });
  if (!activities.length) return '';
  const sorted = [...activities].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) if (sorted[index].start < sorted[index - 1].end) return '';
  const courtHours = activities.reduce((sum, item) => sum + (item.end - item.start) / 60 * item.days * courts, 0);
  const courtRevenue = activities.reduce((sum, item) => sum + (item.end - item.start) / 60 * item.days * item.rate * courts, 0);
  const complements = Array.isArray(value.complements) ? value.complements.slice(0, 12) : [];
  const complementCost = complements.reduce((sum, item) => sum + (Number.isFinite(Number(item?.budget)) && Number(item.budget) >= 0 ? Number(item.budget) : 0), 0);
  const investment = courts * reference + complementCost;
  const complementLabels = complements.filter(item => item && (item.budget !== null && item.budget !== undefined || item.pending)).map(item => String(item.label || '').replace(/[<>]/g, '').trim().slice(0, 40)).filter(Boolean).slice(0, 5).join(', ');
  const agenda = activities.slice(0, 4).map(item => `${item.label || 'Actividad'} ${Math.floor(item.start / 60)}:${String(item.start % 60).padStart(2, '0')}–${Math.floor(item.end / 60)}:${String(item.end % 60).padStart(2, '0')} (${item.days}d)`).join(', ');
  const mode = ['percent', 'reservation'].includes(String(value.complementaryMode)) ? String(value.complementaryMode) : 'none';
  const percent = read('complementaryPercent', 1000) ?? 0;
  const reservations = read('complementaryReservations', 1_000_000) ?? 0;
  const spend = read('complementarySpend') ?? 0;
  const complementaryRevenue = mode === 'percent' ? courtRevenue * percent / 100 : mode === 'reservation' ? reservations * spend : 0;
  const total = courtRevenue + complementaryRevenue;
  const payback = investment > 0 && total > 0 ? investment / total : null;
  const currency = ['USD','EUR','ARS','MXN','CLP'].includes(String(value.currency)) ? String(value.currency) : 'USD';
  const format = (amount, digits = 0) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-AR', { maximumFractionDigits: digits }).format(amount);
  return locale === 'en'
    ? ` Commercial simulation (user-declared assumptions, indicative calculation, not an offer): budget ${currency} ${format(budget)}; ${courts} court(s); indicative investment ${currency} ${format(investment)}; ${format(courtHours, 1)} court-hours/month; court revenue ${currency} ${format(courtRevenue)}/month; complementary revenue ${currency} ${format(complementaryRevenue)}/month (revenue, not profit); total ${currency} ${format(total)}/month; theoretical gross recovery ${payback ? `${format(payback, 1)} months` : 'not calculable'}, before operating costs.${complementLabels ? ` Complements: ${complementLabels}.` : ''}${agenda ? ` Schedule: ${agenda}.` : ''}`
    : ` Simulación comercial (supuestos declarados por el interesado, cálculo orientativo, no es una oferta): presupuesto ${currency} ${format(budget)}; ${courts} cancha(s); inversión orientativa ${currency} ${format(investment)}; ${format(courtHours, 1)} horas-canchas/mes; facturación por canchas ${currency} ${format(courtRevenue)}/mes; facturación complementaria ${currency} ${format(complementaryRevenue)}/mes (facturación, no ganancia); total ${currency} ${format(total)}/mes; recuperación bruta teórica ${payback ? `${format(payback, 1)} meses` : 'no calculable'}, antes de gastos operativos.${complementLabels ? ` Complementos: ${complementLabels}.` : ''}${agenda ? ` Agenda: ${agenda}.` : ''}`;
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
export function registerCrmInboundRoutes(app, {
  crmService,
  leadAnalyzer = null,
  emailInboundSecret = '',
  formInboundSecret = '',
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
      const conversation = await crmService.getConversation(conversationId);
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
      const recent = typeof crmService.listActivities === 'function' ? await crmService.listActivities(conversation.id).catch(() => []) : [];
      const duplicate = (recent || []).find(item => item.author === 'experiencia-comercial' && String(item.summary || '').startsWith(baseSummary) && Date.now() - new Date(item.created_at).getTime() < 15 * 60 * 1000);
      if (duplicate) return res.status(200).json({ ok: true, activityId: duplicate.id, conversationId: conversation.id, assignedTo: 'Nicolás Renedo', duplicate: true });
      const nextStep = action === 'proposal' ? 'Nicolás Renedo · preparar cotización personalizada' : `Nicolás Renedo · coordinar ${contactMode === 'video' ? 'videollamada' : 'llamada'} con el interesado`;
      const payload = { contact_id: conversation.contact_id, conversation_id: conversation.id, activity_type: 'note', summary: summary.slice(0, 1900), next_step: nextStep, follow_up_at: null, author: 'experiencia-comercial' };
      let activity;
      try { activity = await crmService.createActivity(payload); }
      catch { const { next_step, ...fallback } = payload; activity = await crmService.createActivity(fallback); }
      if (!['cerrado', 'closed'].includes(String(conversation.estado || '').toLowerCase())) {
        await crmService.markHandoff({ conversationId: conversation.id, operador: 'Nicolás Renedo' }).catch(error => logger?.warn?.('[crm-experience] handoff failed', { code: error?.code || 'HANDOFF_FAILED' }));
      }
      if (typeof onExperienceAction === 'function') queueMicrotask(() => Promise.resolve(onExperienceAction({ conversation, action, contactMode, preferredTime })).catch(() => {}));
      return res.status(201).json({ ok: true, activityId: activity?.id || null, conversationId: conversation.id, assignedTo: 'Nicolás Renedo' });
    } catch (error) { return reject(res, error, 'experience'); }
  });

  app.post('/api/inbound/crm/prospect-reply', async (req, res) => {
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
