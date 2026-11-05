import { protectedTerritoryFor } from './crmProspectTerritories.js';
import { prospectFollowupEligibility } from './crmProspectFollowupGuard.js';

/** Daily sequence gate. It never sends while send_enabled is false. */
export async function runDueProspectMessages(db, { pool = null, now = new Date(), limit = 50 } = {}) {
  const settings = await db.from('crm_prospect_settings').select('send_enabled,daily_limit').eq('singleton', true).maybeSingle();
  const sendEnabled = settings.data?.send_enabled === true;
  const cap = Math.max(1, Math.min(limit, Number(settings.data?.daily_limit) || 50));
  const { data: messages, error } = await db.from('crm_prospect_messages')
    .select('*, prospect:crm_prospects(*)')
    .in('status', ['simulated', 'queued'])
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at')
    .limit(cap);
  if (error) throw Object.assign(Error('No se pudieron leer los seguimientos.'), { status: 503, code: 'PROSPECT_RUN_UNAVAILABLE' });
  const due = [];
  const excluded = [];
  for (const message of messages || []) {
    const prospect = message.prospect;
    if (!prospect) { excluded.push({ id: message.id, reason: 'Prospecto no disponible' }); continue; }
    if (['opt_out', 'bounced', 'rejected', 'existing', 'paused'].includes(prospect.status)) { excluded.push({ id: message.id, reason: `Estado ${prospect.status}` }); continue; }
    if (prospect.contact_block_reason) { excluded.push({ id: message.id, reason: prospect.contact_block_reason }); continue; }
    const guard = await prospectFollowupEligibility({db,prospect,message,now});
    if (!guard.allowed) { excluded.push({ id: message.id, reason: guard.reason, code: guard.code }); continue; }
    const territory = await protectedTerritoryFor(pool, prospect);
    if (territory) { excluded.push({ id: message.id, reason: `Territorio protegido: ${territory.reason}` }); continue; }
    if (!prospect.email || prospect.data_status?.email !== 'confirmed') { excluded.push({ id: message.id, reason: 'Correo no confirmado' }); continue; }
    if (/\{\{experienceUrl\}\}/.test(String(message.body || ''))) { excluded.push({ id: message.id, reason: 'Enlace de experiencia no publicado' }); continue; }
    if (/\{\{unsubscribeUrl\}\}/.test(String(message.body || ''))) { excluded.push({ id: message.id, reason: 'Baja funcional no configurada' }); continue; }
    due.push({ id: message.id, campaignId: message.campaign_id, prospectId: message.prospect_id, recipient: message.recipient, day: message.step_day, status: sendEnabled ? 'ready' : 'simulated' });
  }
  return { sendEnabled, dryRun: !sendEnabled, checked: messages?.length || 0, due: due.length, excluded: excluded.length, items: due, exclusions: excluded };
}
