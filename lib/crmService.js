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

export function createCrmService({ repository, now = () => new Date() } = {}) {
  if (!repository) throw crmError('El repositorio CRM no está configurado.');

  return {
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
        return { status: 'idempotent', contact, ambiguous, conversation: null };
      }
      const { conversation, created } = await this.createConversation({
        contactId: contact.id,
        sourceChannel: channel,
        sourceRef: sourceId,
        attemptId,
        identityUsed: identityUsed ?? email ?? phone,
        origin: origin ?? source,
        subject,
        body,
        receivedAt,
      });
      return { status: created ? 'accepted' : 'idempotent', contact, ambiguous, conversation };
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
    findContactsByEmailOrPhone(email, phone) {
      let builder = supabaseAdmin.from('crm_contacts').select('*').or(
        [email && `email_normalized.eq.${email}`, phone && `phone_normalized.eq.${phone}`].filter(Boolean).join(','),
      );
      return q(builder);
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
    async createConversation(payload) {
      const { data } = await supabaseAdmin.from('crm_conversations').insert(payload).select('*').single();
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
    async markHandoff({ conversationId, operador }) {
      const { error } = await supabaseAdmin.from('crm_conversations').update({
        estado: 'derivado', derivado: true, operador, updated_at: new Date().toISOString(),
      }).eq('id', conversationId);
      if (error) throw crmError('No se pudo derivar.');
    },
    async listAuditActivity() {
      const [contacts, conversations, attempts, replies] = await Promise.all([
        q(supabaseAdmin.from('crm_contacts').select('id, email_normalized, phone_normalized, nombre, review_needed, created_at')),
        q(supabaseAdmin.from('crm_conversations').select('*').order('created_at', { ascending: false }).limit(200)),
        q(supabaseAdmin.from('crm_channel_attempts').select('*')),
        q(supabaseAdmin.from('crm_replies').select('*').order('created_at', { ascending: false }).limit(200)),
      ]);
      return { contacts, conversations, attempts, replies };
    },
  };
}
