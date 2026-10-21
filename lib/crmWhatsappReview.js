import { createHash, randomUUID } from 'node:crypto';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Audit preparation only. Recording evidence does not verify its authenticity or release the attempt.
export function createWhatsappReviewRecorder({ repository, canAudit } = {}) {
  if (!repository || typeof canAudit !== 'function') throw new Error('Review dependencies required');
  return async ({ actor, replyId, reviewId = randomUUID(), kind, evidence = '' } = {}) => {
    if (!actor?.userId || !uuid.test(actor.userId) || !await canAudit(actor)) throw Object.assign(new Error('Acceso denegado'),{status:403});
    if (!uuid.test(replyId || '') || !uuid.test(reviewId || '') || !['provider_receipt','provider_status','no_conclusive_evidence'].includes(kind)) throw Object.assign(new Error('Revisión inválida'),{status:400});
    const value = String(evidence || '').trim();
    if (kind === 'no_conclusive_evidence' ? value !== '' : !value || value.length > 2048) throw Object.assign(new Error('Evidencia inválida'),{status:400});
    const hash = value ? createHash('sha256').update(value,'utf8').digest('hex') : null;
    const result = await repository.logWhatsappReview({id:reviewId,replyId,reviewerId:actor.userId,kind,evidenceHash:hash});
    return {reviewId:result.id,status:'pending',released:false};
  };
}
