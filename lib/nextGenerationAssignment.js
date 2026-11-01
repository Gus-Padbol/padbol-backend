// Assignment and its event share one connection/transaction. No network side effects.
const normalizedCategory = value => String(value ?? '').trim().toLowerCase();
function failure(code, status = 409) {
  const error = new Error(code); error.code = code; error.status = status; return error;
}
const allowed = (scope, sedeId) => scope?.superA || scope?.rol === 'super_admin'
  || (scope?.rol === 'admin_club' && Number(scope.sedeId) > 0 && Number(scope.sedeId) === Number(sedeId));

export async function assignNextGenerationRegistration(pool, { registrationId, sedeId, sessionId, category, scope }) {
  if (!pool?.connect) throw failure('NG_ASSIGNMENT_UNAVAILABLE', 503);
  let client;
  try { client = await pool.connect(); } catch { throw failure('NG_ASSIGNMENT_UNAVAILABLE', 503); }
  let commitStarted = false, discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    const ids = (await client.query('SELECT $1::uuid AS registration_id,$2::uuid AS session_id', [registrationId, sessionId])).rows[0];
    registrationId = ids.registration_id; sessionId = ids.session_id;
    const r = (await client.query('SELECT * FROM public.ng_inscripciones WHERE id=$1 FOR UPDATE', [registrationId])).rows[0];
    if (!r) throw failure('NG_REGISTRATION_NOT_FOUND', 404);
    // Recheck the current row under lock: the earlier HTTP lookup may be stale.
    if (!allowed(scope, r.sede_id) || !allowed(scope, sedeId)) throw failure('NG_ADMIN_FORBIDDEN', 403);
    if (r.estado === 'cancelada') throw failure('NG_REGISTRATION_CANCELLED', 400);
    if (!['borrador', 'confirmada', 'en_espera'].includes(r.estado)) throw failure('NG_REGISTRATION_STATE_INVALID');
    if (Number(r.sede_id) === Number(sedeId) && r.sesion_id === sessionId && r.categoria === category) {
      await client.query('COMMIT'); return r;
    }
    // Consistent ordering also serializes capacity checks with existing confirmation RPCs.
    const sessions = (await client.query('SELECT * FROM public.ng_sesiones WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...new Set([r.sesion_id, sessionId].filter(Boolean))]])).rows;
    const target = sessions.find(s => s.id === sessionId);
    if (!target || Number(target.sede_id) !== Number(sedeId)) throw failure('NG_SESSION_INVALID', 400);
    if (['cerrada', 'cancelada'].includes(target.estado)) throw failure('NG_SESSION_CLOSED');
    // Compare recorded labels only; do not infer ages or translate historic U13/U15/U17.
    if (!normalizedCategory(target.categoria) || normalizedCategory(target.categoria) !== normalizedCategory(category)
      || (r.estado === 'confirmada' && normalizedCategory(r.categoria) !== normalizedCategory(category))) {
      throw failure('NG_CATEGORY_MISMATCH');
    }
    if (r.estado === 'confirmada') {
      if (!['programada', 'activa'].includes(target.estado)) throw failure('NG_SESSION_NOT_OPEN');
      const used = Number((await client.query("SELECT count(*) AS used FROM public.ng_inscripciones WHERE sesion_id=$1 AND estado='confirmada' AND id<>$2", [sessionId, r.id])).rows[0].used);
      if (used >= Number(target.cupo)) throw failure('NG_SESSION_FULL');
    }
    const moved = r.sesion_id !== sessionId;
    let position = r.posicion_espera;
    if (moved && r.estado === 'en_espera') {
      await client.query("UPDATE public.ng_inscripciones SET posicion_espera=posicion_espera-1,updated_at=now() WHERE sesion_id=$1 AND estado='en_espera' AND posicion_espera>$2", [r.sesion_id, position]);
      position = Number((await client.query("SELECT coalesce(max(posicion_espera),0)+1 AS next FROM public.ng_inscripciones WHERE sesion_id=$1 AND estado='en_espera' AND id<>$2", [sessionId, r.id])).rows[0].next);
    }
    const updated = (await client.query('UPDATE public.ng_inscripciones SET sede_id=$2,sesion_id=$3,categoria=$4,posicion_espera=$5,updated_at=now() WHERE id=$1 RETURNING *', [r.id, sedeId, sessionId, category, position])).rows[0];
    await client.query("INSERT INTO public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle) VALUES($1,$2,'asignacion_actualizada',$3,$4::jsonb)", [r.id, sessionId, scope?.email || null, JSON.stringify({ sede_id: sedeId, categoria: category, previous_session_id: r.sesion_id })]);
    // Assignment historically did not auto-promote the source waitlist. Keep that policy unchanged.
    commitStarted = true;
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { discard = true; });
    if (commitStarted) {
      // COMMIT may have succeeded: never compensate or automatically repeat the mutation.
      throw failure('NG_ASSIGNMENT_OUTCOME_UNCERTAIN', 503);
    }
    if (error.status) throw error;
    if (error.code === '22P02') throw failure('NG_SESSION_INVALID', 400);
    throw failure('NG_ASSIGNMENT_UNAVAILABLE', 503);
  } finally { client.release(discard); }
}
