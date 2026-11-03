import { randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from './crmContact.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['nuevo', 'en_atencion', 'en_espera', 'cerrado']);
const ACTIVITY_TYPES = new Set(['note', 'phone_call', 'zoom_meeting', 'in_person_meeting', 'email', 'other']);
const INTERESTS = new Set(['cancha', 'club', 'sede', 'representacion_regional', 'representacion_nacional', 'otra']);
const DEFAULT_MANAGER = '7225442b-defd-42c1-a5a2-b9c1c339fa69';

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function optionalIso(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail(400, 'MANUAL_INVALID_SCHEDULE', 'La fecha de próximo contacto no es válida.');
  return date.toISOString();
}

function reminderHours(value) {
  if (value == null || value === '') return [24, 8];
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw fail(400, 'MANUAL_INVALID_REMINDERS', 'Indicá entre 1 y 5 horas de aviso.');
  const hours = [...new Set(value.map(Number))].sort((a, b) => b - a);
  if (hours.some(h => !Number.isSafeInteger(h) || h < 1 || h > 720)) throw fail(400, 'MANUAL_INVALID_REMINDERS', 'Las horas de aviso deben estar entre 1 y 720.');
  return hours;
}

function status(value) {
  const result = text(value, 32) || 'nuevo';
  if (!STATUSES.has(result)) throw fail(400, 'MANUAL_INVALID_STATUS', 'Estado comercial inválido.');
  return result;
}

function conversationState(value) {
  return value === 'cerrado' ? 'cerrado' : value === 'nuevo' ? 'nuevo' : 'en_atencion';
}

function manualFields(input, normalized) {
  return {
    Nombre: normalized.name || null,
    Correo: normalized.email || null,
    'Teléfono': normalized.phone ? `+${normalized.phone}` : null,
    'Empresa, club o sede': normalized.company || null,
    'País': normalized.country || null,
    'Ciudad': normalized.city || null,
    'Tipo de interés': normalized.interest || null,
    'Origen conocido': normalized.sourceDetail || null,
    'Notas iniciales': normalized.notes || null,
  };
}

export function normalizeManualLead(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'MANUAL_INVALID', 'Datos del lead inválidos.');
  const name = text(input.name, 160);
  const rawEmail = text(input.email, 254);
  const rawPhone = text(input.phone, 32);
  if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) throw fail(400, 'MANUAL_INVALID_EMAIL', 'Ingresá un correo válido.');
  if (rawPhone && !/^\+?[0-9 ().-]+$/.test(rawPhone)) throw fail(400, 'MANUAL_INVALID_PHONE', 'Ingresá un teléfono válido.');
  const email = normalizeEmail(rawEmail);
  const phone = normalizePhone(rawPhone);
  if (rawEmail && !email) throw fail(400, 'MANUAL_INVALID_EMAIL', 'Ingresá un correo completo.');
  if (rawPhone && !phone) throw fail(400, 'MANUAL_INVALID_PHONE', 'El teléfono debe tener entre 8 y 15 dígitos.');
  if (!email && !phone) throw fail(400, 'MANUAL_CONTACT_REQUIRED', 'Ingresá un correo o un teléfono.');
  if (!name && !email && !phone) throw fail(400, 'MANUAL_CONTACT_REQUIRED', 'Ingresá nombre, correo o teléfono.');
  const company = text(input.company, 160);
  const country = text(input.country, 120);
  const city = text(input.city, 120);
  const interest = text(input.interest, 80);
  if (interest && !INTERESTS.has(interest)) throw fail(400, 'MANUAL_INVALID_INTEREST', 'Tipo de interés inválido.');
  const notes = text(input.notes, 2000);
  const nextStep = text(input.nextStep, 2000);
  const sourceDetail = text(input.sourceDetail, 200);
  const nextContactAt = optionalIso(input.nextContactAt);
  const reminders = reminderHours(input.reminderHours);
  const leadStatus = status(input.status);
  const activityType = text(input.activityType, 32) || 'note';
  if (!ACTIVITY_TYPES.has(activityType)) throw fail(400, 'MANUAL_INVALID_ACTIVITY', 'Tipo de gestión inválido.');
  const closureOutcome = input.closureOutcome === 'venta_concretada' || input.closureOutcome === 'no_avanzo' ? input.closureOutcome : null;
  if (leadStatus === 'cerrado' && !closureOutcome) throw fail(400, 'MANUAL_CLOSURE_REQUIRED', 'Indicá si la venta se concretó o no avanzó.');
  return {
    name, email, phone, company, country, city, interest, notes, nextStep,
    nextContactAt, reminderHours: reminders, status: leadStatus, activityType,
    sourceDetail, closureOutcome,
    assignedAdvisorId: input.assignedAdvisorId ? text(input.assignedAdvisorId, 36) : null,
    force: input.force === true,
    fields: { ...manualFields(input, {name, email, phone, company, country, city, interest, sourceDetail, notes}) },
  };
}

async function findContactByPhoneOrEmail(db, email, phone) {
  const queries = [];
  if (email) queries.push(db.from('crm_contacts').select('*').eq('email_normalized', email).maybeSingle());
  if (phone) queries.push(db.from('crm_contacts').select('*').eq('phone_normalized', phone).maybeSingle());
  const results = await Promise.all(queries);
  const rows = results.map(r => r.data).filter(Boolean);
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  if (unique.length > 1) throw fail(409, 'MANUAL_IDENTITY_CONFLICT', 'El correo y el teléfono pertenecen a contactos distintos.');
  return unique[0] || null;
}

async function latestManualConversation(db, contactId) {
  const { data, error } = await db.from('crm_conversations')
    .select('id,contact_id,origin,estado,subject,received_at,created_at')
    .eq('contact_id', contactId).eq('origin', 'manual')
    .neq('estado', 'cerrado').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo comprobar si el lead ya existe.');
  return data || null;
}

async function caseFor(db, conversationId) {
  const { data, error } = await db.from('crm_commercial_form_cases')
    .select('conversation_id,assigned_user_id,assignment_version,progress_state,commercial_next_step,next_contact_at,reminder_hours,closure_outcome')
    .eq('conversation_id', conversationId).maybeSingle();
  if (error) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo leer la ficha comercial.');
  return data || null;
}

async function advisor(db, id) {
  if (!UUID.test(String(id || ''))) throw fail(400, 'MANUAL_INVALID_ADVISOR', 'Responsable inválido.');
  const { data, error } = await db.from('crm_commercial_advisors').select('user_id,email,active').eq('user_id', id).maybeSingle();
  if (error) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo comprobar el responsable.');
  if (!data?.active) throw fail(400, 'MANUAL_INVALID_ADVISOR', 'El responsable no está activo.');
  return data;
}

async function audit(db, ctx, action, conversationId, details) {
  try {
    await db.from('crm_commercial_team_audit').insert({ actor_id: ctx.actor, action, subject_id: conversationId, details });
  } catch { /* the lead itself is the source of truth; audit is best-effort */ }
}

function normalizeContactForResponse(contact) {
  return contact ? {
    id: contact.id,
    nombre: contact.nombre ?? null,
    email_normalized: contact.email_normalized ?? null,
    phone_normalized: contact.phone_normalized ?? null,
  } : null;
}

function caseStatus(value) { return STATUSES.has(value) ? value : 'nuevo'; }

export async function searchManualLeads(db, query) {
  const q = text(query, 160);
  if (!q) return { matches: [] };
  const email = q.includes('@') ? normalizeEmail(q) : null;
  const phone = /^[0-9 +().-]{8,32}$/.test(q) ? normalizePhone(q) : null;
  const name = q.replace(/[%_]/g, '').trim();
  const queries = [];
  if (email) queries.push(db.from('crm_contacts').select('id,nombre,email_normalized,phone_normalized').eq('email_normalized', email).limit(10));
  if (phone) queries.push(db.from('crm_contacts').select('id,nombre,email_normalized,phone_normalized').eq('phone_normalized', phone).limit(10));
  if (name.length >= 2) queries.push(db.from('crm_contacts').select('id,nombre,email_normalized,phone_normalized').ilike('nombre', `%${name}%`).limit(10));
  const results = await Promise.all(queries);
  const rows = results.flatMap(r => r.data || []);
  const contacts = [...new Map(rows.map(row => [row.id, row])).values()].slice(0, 12);
  if (!contacts.length) return { matches: [] };
  const ids = contacts.map(c => c.id);
  const { data: conversations } = await db.from('crm_conversations')
    .select('id,contact_id,origin,estado,subject,received_at,created_at')
    .in('contact_id', ids).eq('origin', 'manual')
    .order('created_at', { ascending: false });
  const byContact = new Map();
  for (const c of conversations || []) if (!byContact.has(c.contact_id)) byContact.set(c.contact_id, c);
  const conversationIds = [...byContact.values()].map(c => c.id);
  const { data: cases } = conversationIds.length
    ? await db.from('crm_commercial_form_cases').select('conversation_id,assigned_user_id,progress_state,commercial_next_step,next_contact_at').in('conversation_id', conversationIds)
    : { data: [] };
  const caseByConversation = new Map((cases || []).map(c => [c.conversation_id, c]));
  return {
    matches: contacts.map(contact => {
      const conversation = byContact.get(contact.id) || null;
      const currentCase = conversation ? caseByConversation.get(conversation.id) || null : null;
      return {
        ...contact,
        conversation_id: conversation?.id || null,
        case_id: conversation?.id || null,
        status: currentCase?.progress_state || conversation?.estado || null,
        assigned_advisor_id: currentCase?.assigned_user_id || null,
        next_step: currentCase?.commercial_next_step || null,
        next_contact_at: currentCase?.next_contact_at || null,
        match_reasons: [email ? 'correo' : null, phone ? 'teléfono' : null, name ? 'nombre' : null].filter(Boolean),
      };
    }),
  };
}

export async function createManualLead(db, ctx, input) {
  const lead = normalizeManualLead(input);
  let contact = await findContactByPhoneOrEmail(db, lead.email, lead.phone);
  if (contact && !lead.force) {
    const existing = await latestManualConversation(db, contact.id);
    if (existing) {
      return { ok: true, existing: true, contact: normalizeContactForResponse(contact), conversationId: existing.id, caseId: existing.id, status: existing.estado };
    }
  }
  if (!contact) {
    const { data, error } = await db.from('crm_contacts').insert({
      nombre: lead.name || null, email_normalized: lead.email, phone_normalized: lead.phone, review_needed: false,
    }).select('*').single();
    if (error?.code === '23505') contact = await findContactByPhoneOrEmail(db, lead.email, lead.phone);
    else if (error) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo guardar el contacto.');
    else contact = data;
  }
  if (!contact?.id) throw fail(409, 'MANUAL_IDENTITY_CONFLICT', 'Revisá el correo y el teléfono ingresados.');
  let assigned = lead.assignedAdvisorId;
  if (assigned) {
    const person = await advisor(db, assigned);
    if (ctx.role === 'advisor' && person.user_id !== ctx.actor) throw fail(403, 'MANUAL_FORBIDDEN', 'Solo podés asignarte el lead a vos.');
  } else {
    assigned = ctx.role === 'advisor' ? ctx.actor : DEFAULT_MANAGER;
    if (ctx.role !== 'advisor') await advisor(db, assigned);
  }
  if (ctx.role === 'advisor' && assigned !== ctx.actor) throw fail(403, 'MANUAL_FORBIDDEN', 'Solo podés crear leads a tu nombre.');
  const conversationId = randomUUID();
  const qualificationData = {
    manual: {
      version: 1,
      company: lead.company || null,
      country: lead.country || null,
      city: lead.city || null,
      interest: lead.interest || null,
      source_detail: lead.sourceDetail || null,
      created_by: ctx.email || null,
      created_at: new Date().toISOString(),
      updated_by: ctx.email || null,
      updated_at: new Date().toISOString(),
      linked_conversations: [],
    },
    routing: { workflow: 'commercial_lead', country: lead.country || null },
    form_submission: { form: 'manual', fields: { ...lead.fields, workflow: 'commercial_lead' } },
  };
  const subject = `Carga manual · ${lead.interest || lead.name || 'Lead comercial'}`.slice(0, 512);
  const { data: conversation, error } = await db.from('crm_conversations').insert({
    id: conversationId,
    contact_id: contact.id,
    source_channel: 'email',
    source_ref: `manual:${randomUUID()}`,
    attempt_id: `manual:${randomUUID()}`,
    identity_used: lead.email || lead.phone,
    estado: conversationState(lead.status),
    operador: ctx.email || null,
    origin: 'manual',
    subject,
    inbound_body: lead.notes || null,
    qualification_data: qualificationData,
    received_at: new Date().toISOString(),
    next_step: lead.nextStep || null,
  }).select('*').single();
  if (error || !conversation?.id) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo crear la ficha comercial.');
  const currentCase = await caseFor(db, conversation.id);
  if (!currentCase) {
    await db.from('crm_conversations').delete().eq('id', conversation.id);
    throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo habilitar el seguimiento de la ficha.');
  }
  const caseUpdate = {
    assigned_user_id: assigned,
    assignment_version: 0,
    progress_state: lead.status,
    commercial_next_step: lead.nextStep || null,
    next_contact_at: lead.nextContactAt,
    reminder_hours: lead.reminderHours,
    closure_outcome: lead.status === 'cerrado' ? lead.closureOutcome : null,
  };
  const { error: caseError } = await db.from('crm_commercial_form_cases').update(caseUpdate).eq('conversation_id', conversation.id);
  if (caseError) {
    await db.from('crm_conversations').delete().eq('id', conversation.id);
    throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo guardar el seguimiento de la ficha.');
  }
  const activitySummary = lead.notes || lead.nextStep || 'Alta manual del lead.';
  const { error: activityError } = await db.from('crm_activities').insert({
    contact_id: contact.id, conversation_id: conversation.id, activity_type: lead.activityType,
    summary: activitySummary.slice(0, 2000), outcome: null, next_step: lead.nextStep || null,
    follow_up_at: lead.nextContactAt, author: ctx.email || 'crm@padbol.com',
  });
  if (activityError) {
    await db.from('crm_conversations').delete().eq('id', conversation.id);
    throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo guardar la primera gestión.');
  }
  await audit(db, ctx, 'manual_lead_created', conversation.id, {
    contact_id: contact.id, assigned_advisor_id: assigned, status: lead.status, source_detail: lead.sourceDetail || null,
  });
  return { ok: true, existing: false, contact: normalizeContactForResponse(contact), conversationId: conversation.id, caseId: conversation.id, status: lead.status, assignedAdvisorId: assigned };
}

async function linkableConversations(db, conversation) {
  const { data } = await db.from('crm_conversations')
    .select('id,source_channel,origin,subject,received_at').eq('contact_id', conversation.contact_id)
    .neq('id', conversation.id).neq('origin', 'manual').order('received_at', {ascending:false}).limit(12);
  return data || [];
}

export async function linkManualConversation(db, ctx, id, targetId) {
  if (!UUID.test(String(targetId || ''))) throw fail(400, 'MANUAL_INVALID_LINK', 'Conversación inválida.');
  const current = await readManualLead(db, ctx, id);
  if (current.id === targetId) throw fail(400, 'MANUAL_INVALID_LINK', 'No podés vincular la misma ficha.');
  const { data: target, error } = await db.from('crm_conversations').select('id,contact_id,origin,source_channel,subject,received_at').eq('id', targetId).maybeSingle();
  if (error) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo comprobar la conversación.');
  if (!target || target.contact_id !== current.contact.id) throw fail(409, 'MANUAL_LINK_CONTACT_MISMATCH', 'La conversación pertenece a otro contacto.');
  const linked = [...new Set([...(current.manualData.linked_conversations || []), targetId])];
  const { data: row } = await db.from('crm_conversations').select('qualification_data').eq('id', id).maybeSingle();
  const qualificationData = row?.qualification_data || {};
  qualificationData.manual = { ...(qualificationData.manual || {}), linked_conversations: linked, updated_by: ctx.email || null, updated_at: new Date().toISOString() };
  const { error: saveError } = await db.from('crm_conversations').update({ qualification_data: qualificationData, updated_at: new Date().toISOString() }).eq('id', id);
  if (saveError) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo vincular la conversación.');
  await audit(db, ctx, 'manual_lead_linked', id, { target_conversation_id: targetId });
  return readManualLead(db, ctx, id);
}

export async function readManualLead(db, ctx, id) {
  if (!UUID.test(String(id || ''))) throw fail(404, 'MANUAL_NOT_FOUND', 'Ficha no encontrada.');
  const { data: conversation, error } = await db.from('crm_conversations').select('*').eq('id', id).maybeSingle();
  if (error) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo leer la ficha.');
  if (!conversation || conversation.origin !== 'manual') throw fail(404, 'MANUAL_NOT_FOUND', 'Ficha no encontrada.');
  const currentCase = await caseFor(db, id);
  if (!currentCase) throw fail(404, 'MANUAL_NOT_FOUND', 'Ficha no encontrada.');
  const { data: allowed } = await db.rpc('crm_commercial_team_case_allowed', { p_actor: ctx.actor, p_superadmin: ctx.superadmin, p_assigned: currentCase.assigned_user_id });
  if (allowed !== true) throw fail(404, 'MANUAL_NOT_FOUND', 'Ficha no encontrada.');
  const { data: contact } = await db.from('crm_contacts').select('*').eq('id', conversation.contact_id).maybeSingle();
  const { data: activities } = await db.from('crm_activities').select('*').eq('conversation_id', id).order('created_at', { ascending: false }).limit(200);
  const { data: advisorRow } = await db.from('crm_commercial_advisors').select('user_id,email,active').eq('user_id', currentCase.assigned_user_id).maybeSingle();
  return {
    id: conversation.id, manual: true, origin: 'manual', sourceLabel: 'Carga manual',
    contact: normalizeContactForResponse(contact), fields: conversation.qualification_data?.form_submission?.fields || {},
    manualData: conversation.qualification_data?.manual || {}, subject: conversation.subject, notes: conversation.inbound_body,
    status: currentCase.progress_state, nextStep: currentCase.commercial_next_step || conversation.next_step || '',
    nextContactAt: currentCase.next_contact_at || null, reminderHours: currentCase.reminder_hours || [24, 8],
    closureOutcome: currentCase.closure_outcome || null, assignedAdvisor: advisorRow ? { id: advisorRow.user_id, name: advisorRow.email } : null,
    linkedConversations: conversation.qualification_data?.manual?.linked_conversations || [],
    linkableConversations: await linkableConversations(db, conversation),
    activities: activities || [], created_at: conversation.created_at, received_at: conversation.received_at,
  };
}

export async function updateManualLead(db, ctx, id, input) {
  if (!UUID.test(String(id || ''))) throw fail(404, 'MANUAL_NOT_FOUND', 'Ficha no encontrada.');
  const current = await readManualLead(db, ctx, id);
  const lead = normalizeManualLead({
    ...current.manualData,
    name: input.name ?? current.contact?.nombre,
    email: input.email ?? current.contact?.email_normalized,
    phone: input.phone ?? current.contact?.phone_normalized,
    company: input.company ?? current.manualData.company,
    country: input.country ?? current.manualData.country,
    city: input.city ?? current.manualData.city,
    interest: input.interest ?? current.manualData.interest,
    notes: input.notes ?? current.notes,
    nextStep: input.nextStep ?? current.nextStep,
    nextContactAt: input.nextContactAt !== undefined ? input.nextContactAt : current.nextContactAt,
    reminderHours: input.reminderHours ?? current.reminderHours,
    status: input.status ?? current.status,
    sourceDetail: input.sourceDetail ?? current.manualData.source_detail,
    closureOutcome: input.closureOutcome ?? current.closureOutcome,
    activityType: input.activityType,
  });
  const { data: otherEmail } = lead.email ? await db.from('crm_contacts').select('id').eq('email_normalized', lead.email).maybeSingle() : { data: null };
  const { data: otherPhone } = lead.phone ? await db.from('crm_contacts').select('id').eq('phone_normalized', lead.phone).maybeSingle() : { data: null };
  for (const other of [otherEmail, otherPhone]) if (other?.id && other.id !== current.contact?.id) throw fail(409, 'MANUAL_IDENTITY_CONFLICT', 'El correo o teléfono ya pertenece a otra ficha.');
  const { error: contactError } = await db.from('crm_contacts').update({
    nombre: lead.name || null, email_normalized: lead.email, phone_normalized: lead.phone, updated_at: new Date().toISOString(),
  }).eq('id', current.contact.id);
  if (contactError) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo actualizar el contacto.');
  const qualificationData = {
    ...(current.manualData ? { manual: { ...current.manualData, ...{
      company: lead.company, country: lead.country, city: lead.city, interest: lead.interest,
      source_detail: lead.sourceDetail, updated_by: ctx.email || null, updated_at: new Date().toISOString(),
    } } } : {}),
    routing: { workflow: 'commercial_lead', country: lead.country || null },
    form_submission: { form: 'manual', fields: { ...lead.fields, workflow: 'commercial_lead' } },
  };
  const { error: conversationError } = await db.from('crm_conversations').update({
    subject: `Carga manual · ${lead.interest || lead.name || 'Lead comercial'}`.slice(0, 512),
    inbound_body: lead.notes || null, next_step: lead.nextStep || null,
    estado: conversationState(lead.status), qualification_data: qualificationData, updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (conversationError) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo actualizar la ficha.');
  const { error: caseError } = await db.from('crm_commercial_form_cases').update({
    progress_state: lead.status, commercial_next_step: lead.nextStep || null,
    next_contact_at: lead.nextContactAt, reminder_hours: lead.reminderHours,
    closure_outcome: lead.status === 'cerrado' ? lead.closureOutcome : null,
  }).eq('conversation_id', id);
  if (caseError) throw fail(503, 'MANUAL_UNAVAILABLE', 'No se pudo actualizar el seguimiento.');
  await audit(db, ctx, 'manual_lead_updated', id, { contact_id: current.contact.id, status: lead.status });
  return readManualLead(db, ctx, id);
}
