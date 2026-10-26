// Disabled integration candidate: no caller or provider adapter is mounted here.
// The repository must atomically reserve each source submission permanently and
// bind the reservation to its current consent version. Never auto-retry a claim
// that may have reached Meta; reconcile it manually from the delivery receipt.
const LANGUAGES = new Map([['es', 'es'], ['en', 'en']]);

export function contactFromCrmConversation(conversation) {
  const consent = conversation?.qualification_data?.whatsapp_contact_consent;
  if (!consent || typeof consent !== 'object') return null;
  return {
    name: conversation?.contact?.nombre,
    whatsapp: consent.phone,
    language: consent.language,
    whatsapp_followup_consent: consent.accepted === true && consent.purpose === 'consultation_followup',
    whatsapp_followup_consent_at: consent.acceptedAt,
    whatsapp_followup_consent_version: consent.version,
    whatsapp_followup_consent_revoked_at: consent.revokedAt,
  };
}

export function prepareWelcome({ sourceId, contact, templates, enabled = false }) {
  if (enabled !== true) return { eligible: false, reason: 'disabled' };
  if (typeof sourceId !== 'string' || !sourceId.trim()) return { eligible: false, reason: 'missing_source' };
  if (contact?.whatsapp_followup_consent !== true || !contact.whatsapp_followup_consent_at || !contact.whatsapp_followup_consent_version || contact.whatsapp_followup_consent_revoked_at) return { eligible: false, reason: 'missing_consent' };
  const phone = String(contact.whatsapp || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return { eligible: false, reason: 'invalid_phone' };
  const language = LANGUAGES.get(String(contact.language || '').trim().toLowerCase());
  if (!language) return { eligible: false, reason: 'language_unknown' };
  const template = templates?.[language];
  if (template?.approved !== true || typeof template.name !== 'string' || !/^[a-z0-9_]+$/.test(template.name) || typeof template.locale !== 'string' || !template.locale.trim()) return { eligible: false, reason: 'template_not_approved' };
  const name = String(contact.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) return { eligible: false, reason: 'missing_name' };
  return { eligible: true, sourceId: sourceId.trim(), phone, language, template: { name: template.name, locale: template.locale }, name, consentVersion: String(contact.whatsapp_followup_consent_version) };
}

// The injected repository must issue a unique persistent claim and recheck the
// authoritative consent just before transport. A locked claim is never leased
// back for automatic replay, even after a crash or a network timeout.
export async function sendWelcomeCandidate({ sourceId, enabled, templates, repository, transport }) {
  if (enabled !== true) return { status: 'disabled' };
  const contact = await repository.readAuthoritativeContact(sourceId);
  const prepared = prepareWelcome({ sourceId, enabled, templates, contact });
  if (!prepared.eligible) return { status: 'skipped', reason: prepared.reason };
  const claim = await repository.claimOnce({ sourceId: prepared.sourceId, phone: prepared.phone, consentVersion: prepared.consentVersion });
  if (!claim?.acquired) return { status: 'already_claimed' };
  if (!await repository.consentStillValid({ sourceId: prepared.sourceId, phone: prepared.phone, consentVersion: prepared.consentVersion, claimId: claim.id })) {
    await repository.recordSuppressed(claim.id, 'consent_changed');
    return { status: 'suppressed', reason: 'consent_changed' };
  }
  try {
    const result = await transport.sendApprovedTemplate({ to: prepared.phone, template: prepared.template, bodyParameters: [prepared.name] });
    if (!result?.messageId) throw new Error('provider receipt missing');
    await repository.recordAccepted(claim.id, result.messageId);
    return { status: 'accepted', messageId: result.messageId };
  } catch {
    // May already have been accepted by Meta. Never automatically retry.
    await repository.recordUnknown(claim.id);
    return { status: 'unknown' };
  }
}
