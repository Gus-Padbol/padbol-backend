import crypto from 'crypto';
import { summarizeError } from '../../../lib/safeLog.js';

export function hashUserIdForLog(userId) {
  const id = String(userId ?? '').trim();
  if (!id) return '(anonymous)';
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export function logAiChatStart({ skill, userId, messageLength }) {
  console.log('[AI Gateway] chat start', {
    skill,
    user: hashUserIdForLog(userId),
    message_length: messageLength,
  });
}

export function logAiChatSuccess({
  skill,
  userId,
  promptVersion,
  latencyMs,
}) {
  console.log('[AI Gateway] chat ok', {
    skill,
    user: hashUserIdForLog(userId),
    prompt_version: promptVersion,
    latency_ms: latencyMs,
  });
}

export function logAiChatError({
  skill,
  userId,
  err,
  latencyMs,
}) {
  console.error('[AI Gateway] chat error', {
    skill,
    user: hashUserIdForLog(userId),
    latency_ms: latencyMs,
    ...summarizeError(err),
    code: err?.code ?? undefined,
    status: err?.status ?? undefined,
  });
}
