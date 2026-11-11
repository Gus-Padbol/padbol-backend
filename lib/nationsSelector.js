/** Selector declarativo de participantes adultos: nombres+país, id opaco, sin cuentas/ranking. */
import crypto from 'node:crypto';
import {resolveNationsParticipantHistory} from './torneos/nationsParticipantHistory.js';

const ADULT_ONLY_SLUG = 'nations-cup-napoli-2026';
const SELECTION_ID = /^[a-f0-9]{32}$/;

function fail(code, status = 400) {
  return Object.assign(new Error(code), {code, status});
}

export function selectionIdFor(torneoId, participanteId) {
  return crypto.createHash('sha256')
    .update(`nations-selector:${Number(torneoId)}:${String(participanteId)}`)
    .digest('hex')
    .slice(0, 32);
}

async function event(q, slug) {
  const e = (await q.query(
    'select torneo_id, enabled from public.nations_activation_events where slug=$1', [slug])).rows[0];
  if (!e || e.enabled !== true) throw fail('EVENT_NOT_AVAILABLE', 404);
  return e;
}

async function verifiedActor(q, actor) {
  if (!actor?.id) throw fail('AUTH_REQUIRED', 401);
  const u = (await q.query('select email_confirmed_at from auth.users where id=$1', [actor.id])).rows[0];
  if (!u?.email_confirmed_at) throw fail('VERIFIED_ACCOUNT_REQUIRED', 401);
}

/** Resuelve un id opaco contra los adultos del evento; nunca acepta UUID canónico del cliente. */
export async function resolveSelection(q, torneoId, selectionId, slug = ADULT_ONLY_SLUG) {
  const id = String(selectionId || '').trim();
  if (!SELECTION_ID.test(id)) return null;
  if (slug !== ADULT_ONLY_SLUG) return null;
  const rows = (await q.query(
    `select p.id, p.nombre as name, m.country, m.age_status as age_status
       from public.torneo_participantes p
       join public.nations_activation_participants m
         on m.participante_id=p.id and m.torneo_id=p.torneo_id
      where p.torneo_id=$1 and m.minor=false and m.age_status in ('adulto','desconocido')
      order by m.country, p.nombre, p.id`, [torneoId])).rows;
  const row = rows.find((item) => selectionIdFor(torneoId, item.id) === id);
  return row ? {id: row.id, name: row.name, country: row.country, ageStatus: row.age_status} : null;
}

export function createNationsSelectorService({pool, loadOfficialSource = null}) {
  return {
    /** Lista pública sólo nombre+país; sin UUID, cuenta, email, teléfono, DOB, ranking ni menores explícitos. */
    async list(slug) {
      if (slug !== ADULT_ONLY_SLUG) throw fail('SELECTOR_NOT_AVAILABLE', 404);
      const e = await event(pool, slug);
      const rows = (await pool.query(
        `select p.id, p.nombre as name, m.country, m.age_status as age_status
           from public.torneo_participantes p
           join public.nations_activation_participants m
             on m.participante_id=p.id and m.torneo_id=p.torneo_id
          where p.torneo_id=$1 and m.minor=false and m.age_status in ('adulto','desconocido')
          order by m.country, p.nombre, p.id`, [e.torneo_id])).rows;
      return {
        ok: true,
        ageBasis: 'event_18_plus',
        participants: rows.map((row) => ({
          selectionId: selectionIdFor(e.torneo_id, row.id),
          name: row.name,
          country: String(row.country || '').toUpperCase(),
        })),
      };
    },

    /** Historial FIPA read-only por selección: exacto, 0 o ambiguo; nunca source_key/cuenta. */
    async history(slug, selectionId) {
      if (slug !== ADULT_ONLY_SLUG) throw fail('SELECTOR_NOT_AVAILABLE', 404);
      const e = await event(pool, slug);
      const selected = await resolveSelection(pool, e.torneo_id, selectionId, slug);
      if (!selected) throw fail('INVALID_SELECTION', 400);
      if (typeof loadOfficialSource !== 'function') throw fail('FIPA_HISTORY_UNAVAILABLE', 503);
      let source;
      try { source = await loadOfficialSource(); }
      catch { throw fail('FIPA_HISTORY_UNAVAILABLE', 503); }
      const players = Array.isArray(source?.players) ? source.players : null;
      if (!players) throw fail('FIPA_HISTORY_UNAVAILABLE', 503);
      const row = resolveNationsParticipantHistory({
        participants: [{name: selected.name, country: selected.country}],
        officialPlayers: players,
      })[0];
      return {ok: true, ...row};
    },

    /** Reporte de duplicado: no revela quién seleccionó ni modifica la cuenta. */
    async report(slug, actor, selectionId) {
      await verifiedActor(pool, actor);
      if (slug !== ADULT_ONLY_SLUG) throw fail('SELECTOR_NOT_AVAILABLE', 404);
      const e = await event(pool, slug);
      const selected = await resolveSelection(pool, e.torneo_id, selectionId, slug);
      if (!selected) throw fail('INVALID_SELECTION', 400);
      await pool.query(
        `insert into public.nations_selector_reports(torneo_id,participante_id,reporter_user_id)
         values($1,$2,$3) on conflict (torneo_id,participante_id,reporter_user_id) do nothing`,
        [e.torneo_id, selected.id, actor.id]);
      return {ok: true, reported: true};
    },
  };
}
