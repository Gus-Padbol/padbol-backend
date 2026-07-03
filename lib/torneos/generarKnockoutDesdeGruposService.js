import { buildClasificacion } from './clasificacionService.js';
import { buildGruposKnockoutBracketPlan } from './gruposKnockoutService.js';
import { linkBracketMatches, mergeBracketLinks } from './knockoutBracketService.js';

const TORNEO_SELECT = 'id, nombre, sede_id, tipo_torneo';

function makeError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Orquesta la generación de la llave eliminatoria desde la fase de grupos.
 * No recalcula finalización ni toca tabla_puntos. Idempotente vía assertGruposKnockoutReady.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {number|string} torneoId
 * @param {{
 *   buildClasificacion?: Function,
 *   buildGruposKnockoutBracketPlan?: Function,
 *   linkBracketMatches?: Function,
 * }} [deps]
 */
export async function generarKnockoutDesdeGrupos(supabaseAdmin, torneoId, deps = {}) {
  const id = Number(torneoId);
  if (!Number.isFinite(id) || id <= 0) {
    throw makeError('ID de torneo inválido', 'torneo_id_invalido', 400);
  }

  const buildClasif = deps.buildClasificacion ?? buildClasificacion;
  const buildPlan = deps.buildGruposKnockoutBracketPlan ?? buildGruposKnockoutBracketPlan;
  const linkFn = deps.linkBracketMatches ?? linkBracketMatches;

  const { data: torneo, error: errTorneo } = await supabaseAdmin
    .from('torneos')
    .select(TORNEO_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (errTorneo) throw errTorneo;
  if (!torneo) throw makeError('Torneo no encontrado', 'torneo_not_found', 404);

  const { data: equipos, error: errEq } = await supabaseAdmin
    .from('equipos')
    .select('id, nombre')
    .eq('torneo_id', id);
  if (errEq) throw errEq;

  const { data: partidos, error: errPart } = await supabaseAdmin
    .from('partidos')
    .select('*')
    .eq('torneo_id', id);
  if (errPart) throw errPart;

  const clasificacion = buildClasif({
    equipos: equipos ?? [],
    partidos: partidos ?? [],
    tipoTorneo: torneo.tipo_torneo,
    scope: 'all',
  });

  // Valida tipo, grupos finalizados, ausencia de llave previa y estructura soportada.
  const { partidosData, clasificados } = buildPlan({
    torneo,
    partidos: partidos ?? [],
    clasificacion,
  });

  const { data: insertados, error: errInsert } = await supabaseAdmin
    .from('partidos')
    .insert(partidosData)
    .select();
  if (errInsert) throw errInsert;

  const rows = insertados ?? [];
  const linkUpdates = linkFn(rows);
  for (const patch of linkUpdates) {
    const { id: partidoId, ...fields } = patch;
    const { error: errLink } = await supabaseAdmin
      .from('partidos')
      .update(fields)
      .eq('id', partidoId);
    if (errLink) throw errLink;
  }

  const partidosFinales = mergeBracketLinks(rows, linkUpdates);

  return {
    ok: true,
    torneo_id: id,
    formato: 'grupos_knockout',
    total: partidosFinales.length,
    partidos: partidosFinales,
    clasificados,
  };
}
