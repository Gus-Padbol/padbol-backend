/**
 * Solicitudes privadas de perfil para Nations: sin reclamar identidad por nombre+país.
 * El actor SIEMPRE sale de auth (nunca del body). Respuesta genérica: no revela coincidencias.
 */
import crypto from 'node:crypto';
import {resolveSelection} from './nationsSelector.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADULT_ONLY_SLUG = 'nations-cup-napoli-2026';
const AGE = new Set(['adulto', 'menor', 'desconocido']);

function fail(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function hashPayload(p) {
  const parts = [p.declaredName.trim(), p.declaredCountry, p.ageStatus, String(p.guardianConsent), String(p.profileConsent)];
  // Compatibilidad: las solicitudes legacy sin selector conservan el hash original.
  if (p.selectionId) parts.push(String(p.selectionId));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
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
      const selectionId = String(body?.selection_id || '').trim();
      if (slug === ADULT_ONLY_SLUG) {
        // Nápoles 2026: lista incluye desconocidos; con selección se usa la edad canónica del registro,
        // sin convertirla. El fallback legacy sin selección exige auto-declaración adulta.
        if (body?.guardian_consent === true) throw fail('GUARDIAN_NOT_ALLOWED', 400);
        if (selectionId && !/^[a-f0-9]{32}$/.test(selectionId)) throw fail('INVALID_SELECTION', 400);
        if (!selectionId && String(body?.age_status || '').trim().toLowerCase() !== 'adulto') throw fail('ADULT_ONLY', 400);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ev = (await client.query(
          'select e.torneo_id, e.enabled from public.nations_activation_events e where e.slug=$1 for update', [slug])).rows[0];
        if (!ev || ev.enabled !== true) throw fail('EVENT_NOT_AVAILABLE', 404);
        let selected = null;
        if (slug === ADULT_ONLY_SLUG) {
          if (selectionId) {
            selected = await resolveSelection(client, ev.torneo_id, selectionId, slug);
            if (!selected) throw fail('INVALID_SELECTION', 400);
          }
        }
        const normalizedBody = selected
          ? {...body, declared_name: selected.name, declared_country: selected.country, age_status: selected.ageStatus, guardian_consent: false}
          : body;
        const input = {...normalizeProfileRequest(normalizedBody), selectionId: selected ? selectionId : ''};
        const hash = hashPayload(input);
        const prior = (await client.query(
          'select id, payload_hash, status, selection_status from public.nations_profile_requests where actor_user_id=$1 and torneo_id=$2 and request_id=$3',
          [actor.id, ev.torneo_id, input.requestId])).rows[0];
        if (prior) {
          if (prior.payload_hash !== hash) throw fail('REQUEST_CONFLICT', 409);
          await client.query('COMMIT');
          return { ok: true, status: prior.status, requestId: input.requestId, selectionStatus: prior.selection_status || 'declarada' };
        }
        const initialSelectionStatus = selected
          ? (selected.ageStatus === 'adulto' ? 'declarada' : 'verificacion_pendiente')
          : 'sin_seleccion';
        await client.query(
          `insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,guardian_consent,profile_consent,payload_hash,selected_participante_id,selection_status)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [ev.torneo_id, actor.id, input.requestId, input.declaredName, input.declaredCountry, input.ageStatus, input.guardianConsent, input.profileConsent, hash, selected?.id || null, initialSelectionStatus]);
        let selectionStatus = initialSelectionStatus;
        if (selected) {
          await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['nations-selector:' + selected.id]);
          const conflicts = (await client.query(
            `select count(*)::int n from public.nations_profile_requests
              where torneo_id=$1 and selected_participante_id=$2 and status in ('pendiente','en_revision','aprobada')`,
            [ev.torneo_id, selected.id])).rows[0].n;
          if (conflicts > 1) {
            selectionStatus = 'en_conflicto';
            await client.query(
              `update public.nations_profile_requests set selection_status='en_conflicto', updated_at=now()
                where torneo_id=$1 and selected_participante_id=$2 and status in ('pendiente','en_revision','aprobada')`,
              [ev.torneo_id, selected.id]);
          }
        }
        await client.query('COMMIT');
        return { ok: true, status: 'pendiente', requestId: input.requestId, selectionStatus };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error?.code === '23505') throw fail('REQUEST_CONFLICT', 409);
        throw error;
      } finally { client.release(); }
    },

    /** Estado propio (para refrescar/timeout). Nunca devuelve datos de terceros. */
    async ownStatus(slug, actor) {
      if (!actor?.id) throw fail('AUTH_REQUIRED', 401);
      const { rows } = await pool.query(
        `select r.request_id, r.status, r.age_status, r.updated_at, r.selection_status
           from public.nations_profile_requests r
           join public.nations_activation_events e on e.torneo_id=r.torneo_id
          where e.slug=$1 and r.actor_user_id=$2 order by r.updated_at desc`, [slug, actor.id]);
      return { ok: true, requests: rows };
    },

    /** Cola central de revisión: solo super_admin con email confirmado. Sin datos de terceros en logs. */
    async pending(slug, reviewer) {
      if (!reviewer?.id) throw fail('AUTH_REQUIRED', 401);
      const role = (await pool.query(
        `select 1 from public.user_roles r join auth.users u on u.id=r.user_id
          where r.user_id=$1 and r.role='super_admin' and u.email_confirmed_at is not null`, [reviewer.id])).rowCount;
      if (!role) throw fail('FORBIDDEN', 403);
      const { rows } = await pool.query(
        `select r.id, r.request_id, r.declared_name, r.declared_country, r.age_status, r.guardian_consent, r.status, r.created_at,
                r.selection_status, r.selected_participante_id,
                (select count(*)::int from public.nations_selector_reports s where s.torneo_id=r.torneo_id and s.participante_id=r.selected_participante_id) as selection_report_count,
                r.actor_user_id, u.email as actor_email, (u.email_confirmed_at is not null) as actor_email_verified
           from public.nations_profile_requests r
           join public.nations_activation_events e on e.torneo_id=r.torneo_id
           left join auth.users u on u.id=r.actor_user_id
          where e.slug=$1 and r.status in ('pendiente','en_revision') order by r.created_at asc limit 200`, [slug]);
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
            where r.id=$1 and e.slug=$2 and e.enabled=true for update of r`, [requestRowId, slug])).rows[0];
        if (!row) throw fail('REQUEST_NOT_FOUND', 404);

        const decision = String(body?.decision || '');
        if (!['aprobar', 'rechazar'].includes(decision)) throw fail('INVALID_DECISION');
        const note = String(body?.note || '').trim();
        if (note.length < 20) throw fail('REVIEW_NOTE_REQUIRED');
        if (decision === 'aprobar' && body?.identity_verified !== true) throw fail('IDENTITY_PROOF_REQUIRED');
        if (decision === 'aprobar') {
          if (slug === ADULT_ONLY_SLUG && row.age_status !== 'adulto') throw fail('ADULT_ONLY', 409);
          const participantId = String(body?.matched_participante_id || '').trim();
          if (!UUID.test(participantId)) throw fail('INVALID_MATCH');
          if (row.age_status === 'desconocido') throw fail('AGE_NOT_VERIFIED', 409);
          if (row.age_status === 'menor' && (row.guardian_consent !== true || body?.guardian_verified !== true)) throw fail('GUARDIAN_CONSENT_REQUIRED', 409);
          if (!['pendiente','en_revision'].includes(row.status)) throw fail('REQUEST_ALREADY_REVIEWED', 409);
          // Lock del participante: evita carreras de dos actores sobre la misma persona.
          const part = (await client.query(
            `select p.id, p.linked_user_id, m.country, m.age_status
               from public.torneo_participantes p
               join public.nations_activation_participants m on m.participante_id=p.id and m.torneo_id=p.torneo_id
              where p.id=$1 and p.torneo_id=$2 for update of p`,
            [participantId, row.torneo_id])).rows[0];
          if (!part) throw fail('PARTICIPANT_NOT_AVAILABLE', 404);
          // Rechequeo DESPUES del lock: otro actor pudo haber vinculado mientras esperabamos.
          if (part.linked_user_id != null && String(part.linked_user_id) !== String(row.actor_user_id)) {
            throw fail('PARTICIPANT_ALREADY_LINKED', 409);
          }
          const duplicado = (await client.query(
            'select 1 from public.torneo_participantes p where p.torneo_id=$1 and p.linked_user_id=$2 and p.id<>$3',
            [row.torneo_id, row.actor_user_id, participantId])).rowCount;
          if (duplicado) throw fail('ACCOUNT_ALREADY_MATCHED', 409);
          // Politica de edad: solo se actualiza el canon si estaba desconocido o coincide.
          if (part.age_status && part.age_status !== 'desconocido' && part.age_status !== row.age_status) {
            throw fail('AGE_MISMATCH', 409);
          }
          if (String(part.country || '').toUpperCase() !== String(row.declared_country || '').toUpperCase()) {
            throw fail('COUNTRY_MISMATCH', 409);
          }
          const vinculo = await client.query(
            `update public.torneo_participantes set linked_user_id=$2, estado_vinculacion='vinculado'
              where id=$1 and torneo_id=$3 and linked_user_id is null`,
            [participantId, row.actor_user_id, row.torneo_id]);
          if (vinculo.rowCount !== 1) throw fail('PARTICIPANT_ALREADY_LINKED', 409);
          await client.query(
            `update public.torneo_participante_equipos set cuenta_user_id=$2 where participante_id=$1 and torneo_id=$3`,
            [participantId, row.actor_user_id, row.torneo_id]);
          if (row.age_status === 'menor') {
            await client.query(`update public.nations_activation_participants set minor=true, age_status='menor', guardian_reviewed_by=$3, guardian_reviewed_at=now() where participante_id=$1 and torneo_id=$2`, [participantId, row.torneo_id, reviewer.id]);
          } else if (row.age_status === 'adulto') {
            await client.query(`update public.nations_activation_participants set minor=false, age_status='adulto' where participante_id=$1 and torneo_id=$2`, [participantId, row.torneo_id]);
          }
          await client.query(
            `update public.nations_profile_requests set status='aprobada', matched_participante_id=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4, updated_at=now() where id=$1`,
            [requestRowId, participantId, reviewer.id, note.slice(0, 500)]);
        } else {
          if (!['pendiente','en_revision'].includes(row.status)) throw fail('REQUEST_ALREADY_REVIEWED', 409);
          await client.query(
            `update public.nations_profile_requests set status='rechazada', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() where id=$1`,
            [requestRowId, reviewer.id, note.slice(0, 500)]);
        }
        await client.query('COMMIT');
        return { ok: true, status: decision === 'aprobar' ? 'aprobada' : 'rechazada' };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    },
  };
}
