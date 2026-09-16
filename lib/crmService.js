import {
  CRM_CHANNELS,
  attemptIdFor,
  matchCrmContact,
  normalizeEmail,
  normalizePhone,
  resolveChannelAttempt,
} from './crmContact.js';

// Servicios persistentes sobre crm_contacts / crm_channel_attempts / crm_conversations.
// El repositorio se inyecta (Supabase en producción, memoria en tests).

function crmError(message, status = 503, code = 'CRM_UNAVAILABLE') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function clean(value, max = 512) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

const QUALIFICATION_STATUSES = new Set(['pending', 'in_progress', 'qualified', 'disqualified', 'needs_review']);
export const CRM_QUALIFIED_HANDOFF_MESSAGE =
  'Gracias, ya tenemos la información necesaria. Vamos a derivar tu solicitud a un asesor, que te contactará en breve.';
export const CRM_NATIONAL_QUALIFICATION_PATH = 'national';
export const CRM_CLUB_ORGANIZATION_TYPE = 'Club o complejo deportivo';
export const CRM_EXISTING_CLUB_FOLLOW_UP = Object.freeze([
  Object.freeze({ id: 'club_name', field: 'club_name', required: true }),
  Object.freeze({ id: 'club_location', field: 'club_location', required: true }),
]);
export const CRM_NATIONAL_INVESTMENT_OPTIONS = Object.freeze([
  'USD 60.000 a 100.000',
  'USD 100.000 a 250.000',
  'Más de USD 250.000',
]);
export const CRM_NATIONAL_QUALIFICATION_QUESTIONS = Object.freeze([
  { id: 'requested_country', field: 'requested_country' },
  {
    id: 'organization_type',
    field: 'organization_type',
    options: Object.freeze([
      Object.freeze({
        id: 'sports_club',
        label: CRM_CLUB_ORGANIZATION_TYPE,
        followUp: CRM_EXISTING_CLUB_FOLLOW_UP,
      }),
    ]),
  },
  { id: 'territorial_capacity', field: 'territorial_capacity' },
  {
    id: 'initial_investment',
    field: 'initial_investment',
    options: CRM_NATIONAL_INVESTMENT_OPTIONS,
  },
]);

export function clubFollowUpForQualification({ selectedPath, qualificationData } = {}) {
  const path = clean(selectedPath, 120);
  const data = qualificationData && typeof qualificationData === 'object' && !Array.isArray(qualificationData)
    ? qualificationData
    : {};
  const hasClub = path === 'club'
    || data.has_existing_club === true
    || clean(data.organization_type, 160) === CRM_CLUB_ORGANIZATION_TYPE;
  return hasClub ? CRM_EXISTING_CLUB_FOLLOW_UP : [];
}

function qualificationJson(value, expected, maxBytes = 16000) {
  const valid = expected === 'array'
    ? Array.isArray(value)
    : value && typeof value === 'object' && !Array.isArray(value);
  if (!valid || JSON.stringify(value).length > maxBytes) {
    throw crmError('Estado de calificación inválido.', 400, 'CRM_QUALIFICATION_INVALID');
  }
  return value;
}

export function createCrmService({ repository, now = () => new Date() } = {}) {
  if (!repository) throw crmError('El repositorio CRM no está configurado.');

  return {
    /** Contrato del embudo guiado. El motor decide prompts/opciones; aquí sólo se valida y persiste. */
    async recordQualificationProgress({
      conversationId, funnelState, selectedPath = null, qualificationData = {},
      qualificationStatus = 'in_progress', nextPrompt = null, promptOptions = [],
      nextStep = null, handoffReady = false, questionsAsked = 0,
    } = {}) {
      if (!conversationId || !clean(funnelState, 120) || !QUALIFICATION_STATUSES.has(qualificationStatus)) {
        throw crmError('Estado de calificación inválido.', 400, 'CRM_QUALIFICATION_INVALID');
      }
      if (handoffReady && qualificationStatus !== 'qualified') {
        throw crmError('El handoff sólo puede habilitarse al completar la calificación.', 409, 'CRM_HANDOFF_NOT_READY');
      }
      const options = qualificationJson(promptOptions, 'array', 12000);
      if (options.length > 12 || options.some((option) => (
        !option || typeof option !== 'object'
        || !clean(option.id, 80) || !clean(option.label, 160)
      ))) {
        throw crmError('Opciones de calificación inválidas.', 400, 'CRM_QUALIFICATION_INVALID');
      }
      const data = qualificationJson(qualificationData, 'object');
      const conversation = await repository.getConversation(conversationId);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      const questionCount = Number(questionsAsked);
      const normalizedPath = clean(selectedPath, 120);
      const questionLimit = normalizedPath === CRM_NATIONAL_QUALIFICATION_PATH ? 4 : 3;
      if (!Number.isInteger(questionCount) || questionCount < 0 || questionCount > questionLimit) {
        throw crmError(
          questionLimit === 4
            ? 'El camino nacional admite como máximo cuatro preguntas.'
            : 'El embudo admite como máximo tres preguntas.',
          400,
          'CRM_QUALIFICATION_INVALID',
        );
      }
      if (conversation.source_channel === 'whatsapp' && /tel[eé]fono|whats\s*app|celular/i.test(String(nextPrompt || ''))) {
        throw crmError('WhatsApp ya aporta el teléfono del contacto.', 400, 'CRM_QUALIFICATION_INVALID');
      }
      if (normalizedPath === CRM_NATIONAL_QUALIFICATION_PATH) {
        const investment = clean(data.initial_investment, 120);
        if (investment && !CRM_NATIONAL_INVESTMENT_OPTIONS.includes(investment)) {
          throw crmError('Rango de inversión nacional inválido.', 400, 'CRM_QUALIFICATION_INVALID');
        }
      }
      const clubFollowUp = clubFollowUpForQualification({ selectedPath: normalizedPath, qualificationData: data });
      if (clubFollowUp.length && (qualificationStatus === 'qualified' || handoffReady)) {
        if (!clean(data.club_name, 160) || !clean(data.club_location, 240)) {
          throw crmError(
            'El club requiere nombre y ubicación antes del handoff.',
            400,
            'CRM_QUALIFICATION_INVALID',
          );
        }
      }
      return repository.updateQualification(conversationId, {
        funnel_state: clean(funnelState, 120),
        selected_path: normalizedPath,
        qualification_data: data,
        qualification_question_count: questionCount,
        qualification_status: qualificationStatus,
        next_prompt: clean(nextPrompt, 2000),
        prompt_options: options.map((option) => ({
          id: clean(option.id, 80), label: clean(option.label, 160),
        })),
        next_step: clean(nextStep, 2000),
        handoff_ready: Boolean(handoffReady),
        updated_at: now().toISOString(),
      });
    },
    /** Crea o localiza el contacto común. Nunca fusiona por nombre; ambiguo → review. */
    async findOrCreateContact({ email, phone, nombre } = {}) {
      const em = normalizeEmail(email);
      const ph = normalizePhone(phone);
      if (!em && !ph) throw crmError('Falta email o teléfono.', 400, 'CRM_CONTACT_INVALID');
      const match = matchCrmContact({ email: em, phone: ph, existing: await repository.findContactsByEmailOrPhone(em, ph) });
      if (match.status === 'exact') return { contact: match.contact, created: false, ambiguous: false };
      if (match.status === 'ambiguous') {
        // No fusionar; los registros existentes quedan separados y marcados para revisión.
        await repository.markContactsReview(match.contacts.map((c) => c.id));
        return { contact: match.contacts[0], created: false, ambiguous: true };
      }
      const contact = await repository.createContact({
        email_normalized: em,
        phone_normalized: ph,
        nombre: clean(nombre, 160),
        review_needed: false,
      });
      return { contact, created: true, ambiguous: false };
    },

    /** Registra el intento de canal y aplica la exclusión temporal (idempotente). */
    async registerChannelAttempt({ attemptId, channel, contactId }) {
      if (!attemptId || !CRM_CHANNELS.includes(channel)) {
        throw crmError('Intento o canal inválido.', 400, 'CRM_ATTEMPT_INVALID');
      }
      const existing = await repository.findAttempt(attemptId);
      const decision = resolveChannelAttempt({ attemptId, channel, existingAttempts: existing ? [existing] : [] });
      if (decision.status === 'idempotent') return { status: 'idempotent', attempt: existing };
      if (decision.status === 'blocked') {
        throw crmError(
          `Este recorrido ya eligió ${decision.channel}; no puede usar ${decision.requested}.`,
          409,
          'CRM_CHANNEL_CONFLICT',
        );
      }
      const attempt = await repository.createAttempt({ attempt_id: attemptId, channel, contact_id: contactId });
      return { status: 'accepted', attempt };
    },

    /** Crea la conversación (idempotente por attempt_id + canal + origen). */
    async createConversation({
      contactId, sourceChannel, sourceRef, attemptId, identityUsed,
      origin, subject, body, receivedAt,
    } = {}) {
      if (!contactId || !sourceChannel || !sourceRef || !attemptId) {
        throw crmError('Conversación incompleta.', 400, 'CRM_CONVERSATION_INVALID');
      }
      const existing = await repository.findConversation(attemptId, sourceChannel, sourceRef);
      if (existing) return { conversation: existing, created: false };
      const conversation = await repository.createConversation({
        contact_id: contactId,
        source_channel: sourceChannel,
        source_ref: clean(sourceRef, 512),
        attempt_id: attemptId,
        identity_used: clean(identityUsed, 160),
        origin: clean(origin, 120) || sourceChannel,
        subject: clean(subject, 512),
        inbound_body: clean(body, 4000),
        received_at: receivedAt || now().toISOString(),
        estado: 'nuevo',
      });
      return { conversation, created: true };
    },

    /** Punto único de ingesta (webhook/form): contacto → intento → conversación, idempotente. */
    async ingestInbound({
      source, sourceId, channel, email, phone, nombre, identityUsed,
      origin, subject, body, receivedAt,
    } = {}) {
      if (!source || !sourceId || !CRM_CHANNELS.includes(channel)) {
        throw crmError('Ingesta inválida.', 400, 'CRM_INGEST_INVALID');
      }
      const attemptId = attemptIdFor({ source, sourceId });
      const { contact, ambiguous } = await this.findOrCreateContact({ email, phone, nombre });
      const attempt = await this.registerChannelAttempt({ attemptId, channel, contactId: contact.id });
      if (attempt.status === 'idempotent') {
        const event = await repository.findInboundEvent(channel, origin ?? source, sourceId);
        if (event) {
          const conversation = await repository.getConversation(event.conversation_id);
          return { status: 'idempotent', contact, ambiguous, conversation };
        }
        const legacyConversation = await repository.findConversation(attemptId, channel, sourceId);
        return { status: 'idempotent', contact, ambiguous, conversation: legacyConversation };
      }
      const eventOrigin = clean(origin ?? source, 120);
      let conversation = null;
      let created = false;
      // Sólo WhatsApp mantiene continuidad por contacto + origen en un hilo no cerrado.
      // Los correos conservan una conversación independiente por message/source id.
      if (channel === 'whatsapp') {
        conversation = await repository.findOpenConversation(contact.id, channel, eventOrigin);
      }
      if (!conversation) {
        const result = await this.createConversation({
          contactId: contact.id,
          sourceChannel: channel,
          sourceRef: sourceId,
          attemptId,
          identityUsed: identityUsed ?? email ?? phone,
          origin: eventOrigin,
          subject,
          body,
          receivedAt,
        });
        conversation = result.conversation;
        created = result.created;
      }
      const event = await repository.createInboundEvent({
        conversation_id: conversation.id,
        source_channel: channel,
        source_ref: clean(sourceId, 512),
        origin: eventOrigin,
        subject: clean(subject, 512),
        body: clean(body, 4000),
        received_at: receivedAt || now().toISOString(),
      });
      if (!created) await repository.touchConversation(conversation.id, event.received_at);
      return { status: 'accepted', contact, ambiguous, conversation, conversationCreated: created };
    },
  };
}

export function createSupabaseCrmRepository(supabaseAdmin) {
  if (!supabaseAdmin?.from) return null;
  const q = async (builder) => {
    const { data, error } = await builder;
    if (error) throw crmError('No se pudo operar el CRM.');
    return data;
  };
  return {
    async findContactsByEmailOrPhone(email, phone) {
      const lookups = [];
      if (email) lookups.push(q(supabaseAdmin.from('crm_contacts').select('*').eq('email_normalized', email).limit(3)));
      if (phone) lookups.push(q(supabaseAdmin.from('crm_contacts').select('*').eq('phone_normalized', phone).limit(3)));
      const rows = (await Promise.all(lookups)).flat();
      return [...new Map(rows.slice(0, 6).map((row) => [row.id, row])).values()];
    },
    async createContact(payload) {
      const { data, error } = await supabaseAdmin.from('crm_contacts').insert(payload).select('*').single();
      if (!error) return data;
      if (error.code === '23505') {
        // Concurrencia: otro request ya creó el contacto. Releer el existente.
        if (payload.email_normalized) {
          const r = await supabaseAdmin.from('crm_contacts').select('*')
            .eq('email_normalized', payload.email_normalized).maybeSingle();
          if (r.data) return r.data;
        }
        if (payload.phone_normalized) {
          const r = await supabaseAdmin.from('crm_contacts').select('*')
            .eq('phone_normalized', payload.phone_normalized).maybeSingle();
          if (r.data) return r.data;
        }
      }
      throw crmError('No se pudo crear el contacto.');
    },
    async markContactsReview(ids) {
      const { error } = await supabaseAdmin.from('crm_contacts').update({ review_needed: true }).in('id', ids);
      if (error) throw crmError('No se pudo marcar revisión.');
    },
    async findAttempt(attemptId) {
      const { data } = await supabaseAdmin.from('crm_channel_attempts').select('*').eq('attempt_id', attemptId).maybeSingle();
      return data || null;
    },
    async createAttempt(payload) {
      const { data } = await supabaseAdmin.from('crm_channel_attempts').insert(payload).select('*').single();
      return data;
    },
    async findConversation(attemptId, sourceChannel, sourceRef) {
      const { data } = await supabaseAdmin.from('crm_conversations').select('*')
        .eq('attempt_id', attemptId).eq('source_channel', sourceChannel).eq('source_ref', sourceRef)
        .maybeSingle();
      return data || null;
    },
    async findInboundEvent(sourceChannel, origin, sourceRef) {
      const { data } = await supabaseAdmin.from('crm_inbound_events').select('*')
        .eq('source_channel', sourceChannel).eq('origin', origin).eq('source_ref', sourceRef)
        .maybeSingle();
      return data || null;
    },
    async findOpenConversation(contactId, sourceChannel, origin) {
      const { data, error } = await supabaseAdmin.from('crm_conversations').select('*')
        .eq('contact_id', contactId).eq('source_channel', sourceChannel).eq('origin', origin)
        .neq('estado', 'cerrado').order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw crmError('No se pudo localizar el hilo CRM.');
      return data || null;
    },
    async createConversation(payload) {
      const { data } = await supabaseAdmin.from('crm_conversations').insert(payload).select('*').single();
      return data;
    },
    async createInboundEvent(payload) {
      const { data, error } = await supabaseAdmin.from('crm_inbound_events').insert(payload).select('*').single();
      if (!error) return data;
      if (error.code === '23505') {
        const existing = await this.findInboundEvent(payload.source_channel, payload.origin, payload.source_ref);
        if (existing) return existing;
      }
      throw crmError('No se pudo registrar el mensaje entrante.');
    },
    async touchConversation(id, receivedAt) {
      const { error } = await supabaseAdmin.from('crm_conversations').update({
        received_at: receivedAt, updated_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) throw crmError('No se pudo actualizar el hilo CRM.');
    },
    async updateQualification(id, payload) {
      const { data, error } = await supabaseAdmin.from('crm_conversations').update(payload).eq('id', id).select('*').single();
      if (error) throw crmError('No se pudo actualizar la calificación.');
      return data;
    },
    async listConversations(filters = {}) {
      let builder = supabaseAdmin.from('crm_conversations').select('*').order('created_at', { ascending: false }).limit(200);
      if (filters.sourceChannel) builder = builder.eq('source_channel', filters.sourceChannel);
      if (filters.estado) builder = builder.eq('estado', filters.estado);
      return q(builder);
    },
    async getConversation(id) {
      const { data } = await supabaseAdmin.from('crm_conversations').select('*').eq('id', id).maybeSingle();
      return data || null;
    },
    async createReply({ conversationId, body, operador, status }) {
      const { data } = await supabaseAdmin.from('crm_replies').insert({
        conversation_id: conversationId, body, operador, status,
      }).select('*').single();
      return data;
    },
    async listActivities(conversationId) {
      return q(supabaseAdmin.from('crm_activities').select('*')
        .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(200));
    },
    async createActivity(payload) {
      const { data, error } = await supabaseAdmin.from('crm_activities').insert(payload).select('*').single();
      if (error) throw crmError('No se pudo registrar el seguimiento.');
      return data;
    },
    async markHandoff({ conversationId, operador }) {
      const { error } = await supabaseAdmin.from('crm_conversations').update({
        estado: 'derivado', derivado: true, operador, updated_at: new Date().toISOString(),
      }).eq('id', conversationId);
      if (error) throw crmError('No se pudo derivar.');
    },
    async listAuditActivity() {
      const [contacts, conversations, attempts, replies, activities] = await Promise.all([
        q(supabaseAdmin.from('crm_contacts').select('id, email_normalized, phone_normalized, nombre, review_needed, created_at')),
        q(supabaseAdmin.from('crm_conversations').select('*').order('created_at', { ascending: false }).limit(200)),
        q(supabaseAdmin.from('crm_channel_attempts').select('*')),
        q(supabaseAdmin.from('crm_replies').select('*').order('created_at', { ascending: false }).limit(200)),
        q(supabaseAdmin.from('crm_activities').select('*').order('created_at', { ascending: false }).limit(500)),
      ]);
      return { contacts, conversations, attempts, replies, activities };
    },
  };
}
