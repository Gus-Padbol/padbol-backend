/**
 * Solicitudes privadas de perfil para Nations: sin reclamar identidad por nombre+país.
 * El actor SIEMPRE sale de auth (nunca del body). Respuesta genérica: no revela coincidencias.
 */
import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGE = new Set(['adulto', 'menor', 'desconocido']);

function fail(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function hashPayload(p) {
  return crypto.createHash('sha256')
    .update([p.declaredName.trim(), p.declaredCountry, p.ageStatus, String(p.guardianConsent), String(p.profileConsent)].join('|'))
    .digest('hex');
}
export function normalizeProfileRequest(body) {
  const requestId = String(body?.request_id || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) throw fail('INVALID_REQUEST_ID');
  const declaredName = String(body?.declared_name || '').trim().replace(/\s+/g, ' ');
  if (declaredName.length < 2 || declaredName.length > 100 || /[<>\x00-\x1f]/.test(declaredName)) throw fail('INVALID_NAME');
  const declaredCountry = String(body?.declared_country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(declaredCountry)) throw fail('INVALID_COUNTRY');
  const ageStatus = String(body?.age_status || '').trim().toLowerCase();
  if (!AGE.has(ageStatus)) throw fail('INVALID_AGE_STATUS');
  const guardianConsent = body?.guardian_consent === true;
  const profileConsent = body?.profile_consent === true;
  if (!profileConsent) throw fail('CONSENT_REQUIRED');
  if (ageStatus === 'menor' && !guardianConsent) throw fail('GUARDIAN_CONSENT_REQUIRED');
  return { requestId, declaredName, declaredCountry, ageStatus, guardianConsent, profileConsent };
}

export function createNationsProfileRequestsService({ pool, now = () => new Date() }) {
  return {
    /** Crea o devuelve la solicitud propia; idempotente por actor+evento+request_id. */
    async submit(slug, actor, body) {
      if (!actor?.id) throw fail('AUTH_REQUIRED', 401);
      if (actor.email_confirmed_at == null) throw fail('VERIFIED_ACCOUNT_REQUIRED', 401);
      const input = normalizeProfileRequest(body);
      const hash = hashPayload(input);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ev = (await client.query(
          'select e.id, e.torneo_id, e.enabled from public.nations_activation_events e where e.slug=$1 for update', [slug])).rows[0];
        if (!ev || ev.enabled !== true) throw fail('EVENT_NOT_AVAILABLE', 404);
        const prior = (await client.query(
          'select id, payload_hash, status from public.nations_profile_requests where actor_user_id=$1 and torneo_id=$2 and request_id=$3',
          [actor.id, ev.torneo_id, input.requestId])).rows[0];
        if (prior) {
          if (prior.payload_hash !== hash) throw fail('REQUEST_CONFLICT', 409);
          await client.query('COMMIT');
          return { ok: true, status: prior.status, requestId: input.requestId };
        }
        await client.query(
          `insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,guardian_consent,profile_consent,payload_hash)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ev.torneo_id, actor.id, input.requestId, input.declaredName, input.declaredCountry, input.ageStatus, input.guardianConsent, input.profileConsent, hash]);
        await client.query('COMMIT');
        return { ok: true, status: 'pendiente', requestId: input.requestId };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    },

    /** Estado propio (para refrescar/timeout). Nunca devuelve datos de terceros. */
    async ownStatus(slug, actor) {
      if (!actor?.id) throw fail('AUTH_REQUIRED', 401);
      const { rows } = await pool.query(
        `select r.request_id, r.status, r.age_status, r.review_note, r.updated_at
           from public.nations_profile_requests r
           join public.nations_activation_events e on e.torneo_id=r.torneo_id
          where e.slug=$1 and r.actor_user_id=$2 order by r.updated_at desc`, [slug, actor.id]);
      return { ok: true, requests: rows };
    },

    /** Revisión central: solo super_admin con email confirmado. */
    async review(slug, reviewer, requestRowId, body) {
      if (!reviewer?.id) throw fail('AUTH_REQUIRED', 401);
      if (!UUID.test(String(requestRowId || ''))) throw fail('INVALID_REQUEST');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const role = (await client.query(
          `select 1 from public.user_roles r join auth.users u on u.id=r.user_id
            where r.user_id=$1 and r.role='super_admin' and u.email_confirmed_at is not null`, [reviewer.id])).rowCount;
        if (!role) throw fail('FORBIDDEN', 403);
        const row = (await client.query(
          `select r.*, e.torneo_id from public.nations_profile_requests r
             join public.nations_activation_events e on e.torneo_id=r.torneo_id
            where r.id=$1 and e.slug=$2 for update of r`, [requestRowId, slug])).rows[0];
        if (!row) throw fail('REQUEST_NOT_FOUND', 404);
        const decision = String(body?.decision || '');
        if (!['aprobar', 'rechazar'].includes(decision)) throw fail('INVALID_DECISION');
        if (decision === 'aprobar') {
          if (row.age_status === 'desconocido') throw fail('AGE_NOT_VERIFIED', 409);
          if (row.age_status === 'menor' && row.guardian_consent !== true) throw fail('GUARDIAN_CONSENT_REQUIRED', 409);
          const participantId = String(body?.matched_participante_id || '').trim();
          if (!UUID.test(participantId)) throw fail('INVALID_MATCH');
          const p = (await client.query(
            'select 1 from public.nations_activation_participants m where m.participante_id=$1 and m.torneo_id=$2',
            [participantId, row.torneo_id])).rowCount;
          if (!p) throw fail('PARTICIPANT_NOT_AVAILABLE', 404);
          await client.query(
            `update public.nations_profile_requests set status='aprobada', matched_participante_id=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4, updated_at=now() where id=$1`,
            [requestRowId, participantId, reviewer.id, String(body?.note || '').slice(0, 500)]);
        } else {
          await client.query(
            `update public.nations_profile_requests set status='rechazada', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() where id=$1`,
            [requestRowId, reviewer.id, String(body?.note || '').slice(0, 500)]);
        }
        await client.query('COMMIT');
        return { ok: true, status: decision === 'aprobar' ? 'aprobada' : 'rechazada' };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    },
  };
}
