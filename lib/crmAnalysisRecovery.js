import { isCommercialFormConversation } from './crmCommercialScope.js';

// Explicit historical recovery only. Completed, pending, failed and test cases
// are never selected or retried by this command.
export function recoverableFormAnalysis(row, allowedIds) {
  return Boolean(row && allowedIds.includes(row.id) && row.source_channel === 'email'
    && row.source_ref && !row.test_hidden_at
    && isCommercialFormConversation(row)
    && !row.qualification_data?.lead_analysis
    && row.qualification_data?.lead_analysis_request?.status === 'disabled'
    && row.qualification_data?.form_submission?.form);
}

export async function recoverFormAnalysis({ row, allowedIds, repository, analyzer, apply = false, now = () => new Date() }) {
  if (!recoverableFormAnalysis(row, allowedIds)) return { status: 'skipped', id: row?.id };
  if (!apply) return { status: 'eligible', id: row.id };
  if (typeof analyzer !== 'function') throw new Error('CRM_ANALYZER_NOT_CONFIGURED');
  const previous = row.qualification_data;
  const claimed = await repository.updateLeadAnalysis(row.id, {
    ...previous,
    lead_analysis_request: { ...previous.lead_analysis_request, status: 'pending', recovery_requested_at: now().toISOString() },
  }, previous);
  if (!claimed) return { status: 'concurrent_update', id: row.id };
  const result = await analyzer({ ingest: {
    sourceId: row.source_ref,
    nombre: row.contact?.nombre,
    email: row.contact?.email_normalized,
    phone: row.contact?.phone_normalized,
    subject: row.subject,
    body: row.inbound_body,
    qualificationData: claimed.qualification_data,
  }, conversation: claimed });
  return { status: result?.status || 'completed', id: row.id };
}
