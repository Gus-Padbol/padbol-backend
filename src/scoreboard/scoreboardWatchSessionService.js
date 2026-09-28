import crypto from 'node:crypto';
import { hashControlToken, parseControlTokenParam } from './scoreboardControlToken.js';
import { assertWatchSessionActive } from './scoreboardWatchAction.js';

const SESSION_SELECT = [
  'id', 'scoreboard_id', 'device_id', 'expires_at', 'revoked_at', 'created_at', 'last_seen_at',
  'pairing_expires_at', 'pairing_claimed_at',
].join(', ');

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generatePairingCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

export function normalizePairingCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code)) {
    throw Object.assign(new Error('pairing_code inválido'), { status: 400 });
  }
  return code;
}

export async function createWatchSession(supabaseAdmin, scoreboardId, ttlSeconds = 43_200) {
  const pairingCode = generatePairingCode();
  const now = new Date();
  const safeTtl = Math.min(Math.max(Number(ttlSeconds) || 43_200, 300), 86_400);
  const row = {
    scoreboard_id: scoreboardId,
    device_id: null,
    token_hash: null,
    pairing_code_hash: hashControlToken(pairingCode),
    pairing_expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    expires_at: new Date(now.getTime() + safeTtl * 1000).toISOString(),
  };
  const { data, error } = await supabaseAdmin.from('scoreboard_control_sessions')
    .insert(row).select(SESSION_SELECT).limit(1);
  if (error) throw error;
  return { session: data?.[0] ?? data, pairingCode };
}

export async function claimWatchSession(supabaseAdmin, rawPairingCode, deviceId) {
  const pairingCode = normalizePairingCode(rawPairingCode);
  const normalizedDeviceId = String(deviceId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalizedDeviceId)) {
    throw Object.assign(new Error('device_id inválido'), { status: 400 });
  }
  const { data, error } = await supabaseAdmin.rpc('scoreboard_claim_watch_pairing', {
    p_pairing_code_hash: hashControlToken(pairingCode),
    p_device_id: normalizedDeviceId,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.status !== 'claimed') {
    throw Object.assign(new Error('Código de emparejamiento inválido, vencido o ya usado'), { status: 401 });
  }
  return result;
}

export async function resolveWatchSession(supabaseAdmin, rawToken, deviceId) {
  const tokenHash = hashControlToken(parseControlTokenParam(rawToken));
  const { data, error } = await supabaseAdmin.from('scoreboard_control_sessions')
    .select(SESSION_SELECT).eq('token_hash', tokenHash).maybeSingle();
  if (error) throw error;
  assertWatchSessionActive(data, deviceId);
  return data;
}

export async function revokeWatchSession(supabaseAdmin, scoreboardId, sessionId) {
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedSessionId)) {
    throw Object.assign(new Error('session_id inválido'), { status: 400 });
  }
  const revokedAt = new Date().toISOString();
  const query = supabaseAdmin.from('scoreboard_control_sessions')
    .update({ revoked_at: revokedAt })
    .eq('scoreboard_id', scoreboardId)
    .eq('id', normalizedSessionId);
  const { error } = await query;
  if (error) throw error;
  return revokedAt;
}
