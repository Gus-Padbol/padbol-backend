// Seguimiento obligatorio de leads.
// No crea un CRM paralelo: usa crm_lead_alerts y los casos comerciales existentes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUIRED_TEXT = (value, min = 3, max = 2000) => typeof value === 'string' && value.trim().length >= min && value.length <= max;

const CHANNELS = ['whatsapp', 'llamada', 'email', 'presencial', 'otro'];
const STATES = ['nuevo', 'en_atencion', 'en_espera', 'cerrado'];

function fail(status, code, message) {
  const error = new Error(message || code);
  error.status = status;
  error.code = code;
  return error;
}

// Reglas de cierre: no se puede cerrar una alerta sin registro completo.
// Si el cliente no respondio, no se puede declarar atendido: exige intento y nuevo contacto.
export function validateCompletion(payload = {}) {
  const contactAt = String(payload.contact_at || '').trim();
  if (!contactAt || !Number.isFinite(Date.parse(contactAt))) throw fail(400, 'CONTACT_DATE_REQUIRED', 'Falta la fecha de contacto.');
  const channel = String(payload.channel || '').trim().toLowerCase();
  if (!CHANNELS.includes(channel)) throw fail(400, 'CONTACT_CHANNEL_REQUIRED', 'Falta el medio de contacto.');
  const outcome = String(payload.outcome || '').trim();
  if (!REQUIRED_TEXT(outcome, 3, 500)) throw fail(400, 'OUTCOME_REQUIRED', 'Falta el resultado de la conversacion.');
  const summary = String(payload.summary || '').trim();
  if (!REQUIRED_TEXT(summary, 20, 2000)) throw fail(400, 'SUMMARY_REQUIRED', 'El resumen debe tener al menos 20 caracteres.');
  const state = String(payload.commercial_state || '').trim().toLowerCase();
  if (!STATES.includes(state)) throw fail(400, 'COMMERCIAL_STATE_REQUIRED', 'Falta el estado comercial.');

  const clientResponded = payload.client_responded !== false;
  const nextAction = String(payload.next_action || '').trim();
  const nextActionAt = payload.next_action_at == null ? null : String(payload.next_action_at).trim();

  if (!clientResponded) {
    if (state === 'cerrado' || payload.attended === true) throw fail(409, 'UNANSWERED_CANNOT_BE_ATTENDED', 'Un cliente que no respondio no puede marcarse como atendido.');
    if (!REQUIRED_TEXT(nextAction, 3, 500)) throw fail(400, 'NEXT_ACTION_REQUIRED', 'Registra el intento y la proxima accion.');
    if (!nextActionAt || !Number.isFinite(Date.parse(nextActionAt))) throw fail(400, 'NEXT_ACTION_DATE_REQUIRED', 'Programa el nuevo contacto.');
    return { contactAt, channel, outcome, summary, state, clientResponded, nextAction, nextActionAt, attended: false };
  }

  if (state === 'cerrado') {
    const reason = String(payload.closure_reason || '').trim();
    if (!REQUIRED_TEXT(reason, 10, 1000)) throw fail(400, 'CLOSURE_REASON_REQUIRED', 'Un cierre necesita motivo justificado.');
    return { contactAt, channel, outcome, summary, state, clientResponded, nextAction: null, nextActionAt: null, attended: true, closureReason: reason };
  }

  if (!REQUIRED_TEXT(nextAction, 3, 500)) throw fail(400, 'NEXT_ACTION_REQUIRED', 'Falta la proxima accion.');
  if (!nextActionAt || !Number.isFinite(Date.parse(nextActionAt))) throw fail(400, 'NEXT_ACTION_DATE_REQUIRED', 'Falta la fecha de la proxima accion.');
  if (Date.parse(nextActionAt) <= Date.now()) throw fail(400, 'NEXT_ACTION_IN_PAST', 'La proxima accion debe ser futura.');
  return { contactAt, channel, outcome, summary, state, clientResponded, nextAction, nextActionAt, attended: true };
}

export function createCrmLeadAlerts({ pool, deliver = null, now = () => new Date(), logger = console } = {}) {
  if (!pool?.query) throw new Error('CRM_LEAD_ALERTS_POOL_REQUIRED');

  async function sweep() {
    const at = now().toISOString();
    const result = await pool.query('select public.crm_lead_alerts_sweep($1) as out', [at]);
    const counts = result.rows[0]?.out || {};
    const pending = await pool.query(
      `select id, case_type, case_id, advisor_id, state, due_reminder_at, due_escalation_at
         from public.crm_lead_alerts
        where resolved_at is null and (reminded_at = $1 or escalated_at = $1)`,
      [at],
    );
    const notified = [];
    if (typeof deliver === 'function') {
      for (const alert of pending.rows) {
        try {
          await deliver({
            alertId: alert.id,
            stage: alert.state,
            caseType: alert.case_type,
            caseId: alert.case_id,
            advisorId: alert.advisor_id,
            escalateToManager: alert.state === 'escalada',
          });
          notified.push(alert.id);
        } catch (error) {
          logger.warn?.('No se pudo notificar la alerta de seguimiento', alert.id, error?.message || error);
        }
      }
    }
    return { ...counts, notified: notified.length };
  }

  async function panel({ advisorId = null, onlyOverdue = false } = {}) {
    const params = [];
    const where = ['a.resolved_at is null'];
    if (advisorId) { params.push(advisorId); where.push(`a.advisor_id = $${params.length}`); }
    if (onlyOverdue) where.push("a.state = 'escalada'");
    const { rows } = await pool.query(
      `select a.id, a.case_type, a.case_id, a.advisor_id, a.state, a.due_reminder_at, a.due_escalation_at,
              c.next_contact_at
         from public.crm_lead_alerts a
         left join public.crm_commercial_cases c on a.case_type='whatsapp' and c.id=a.case_id
        where ${where.join(' and ')}
        order by a.due_escalation_at asc`,
      params,
    );
    const overdue = rows.filter((r) => r.state === 'escalada');
    const withoutNextAction = rows.filter((r) => r.next_contact_at == null);
    return { pending: rows.filter((r) => r.state !== 'escalada'), overdue, withoutNextAction };
  }

  async function resolve(caseType, caseId, reason = 'registro completo') {
    const { rowCount } = await pool.query(
      `update public.crm_lead_alerts
          set state='resuelta', resolved_at=now(), updated_at=now(), resolution=$3
        where case_type=$1 and case_id=$2 and resolved_at is null`,
      [caseType, caseId, reason],
    );
    return { resolved: rowCount };
  }

  return { sweep, panel, resolve };
}

export { UUID };
