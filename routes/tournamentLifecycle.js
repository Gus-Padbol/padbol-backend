import { isNationsEvent } from '../lib/torneos/nationsPublicAccess.js';
import { getTournamentCompletionEvidence, persistGenericTournamentClosure, resolveGenericTournamentClosureDate } from '../lib/torneos/tournamentCompletionService.js';
import { buildFinalRankingForTorneo } from '../lib/torneos/clasificacionService.js';
import { loadPointsPolicy, buildPointsRows } from '../lib/torneos/pointsPolicyService.js';
import { isNationalRoster, closeNationalTournament } from '../lib/nationalTeamLineup.js';
import { collectUserIdsFromEquipos } from '../src/rangos/rangosService.js';
import { cargarResultadoManualPartidoTorneo } from '../lib/torneos/cargarResultadoManualPartidoTorneoService.js';

// Shared production handlers, mounted in their original server.js positions.
// Finalization persists an explicit table-column projection of the ranking DTO.
export function mountTournamentFinalizationRoute(app, { supabase, supabaseAdmin, requireTorneoAdminByTorneoId, actualizarRango, sendHttpError, clock = () => new Date() }) {
app.post('/api/torneos/:id/finalizar', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

    // Load torneo
    const { data: torneo, error: errTorneo } = await supabase
      .from('torneos').select('*').eq('id', id).single();
    if (errTorneo) throw errTorneo;

    if(isNationsEvent(torneo)) return res.status(409).json({code:'NATIONS_ATOMIC_CLOSURE_REQUIRED',error:'Finaliza desde Nations Cup para conservar la siembra y las posiciones aprobadas.'});
    // Load equipos & partidos
    const [{ data: equipos, error: errEq }, { data: partidos, error: errPart }] = await Promise.all([
      supabase.from('equipos').select('*').eq('torneo_id', parseInt(id)),
      supabase.from('partidos').select('*').eq('torneo_id', parseInt(id)),
    ]);
    if (errEq) throw errEq;
    if (errPart) throw errPart;

    // Validate all matches finished
    const pendientes = (partidos || []).filter(p => p.estado !== 'finalizado');
    if (pendientes.length > 0) {
      return res.status(400).json({
        error: `Hay ${pendientes.length} partido(s) sin finalizar. Completa todos los resultados antes de finalizar el torneo.`,
      });
    }

    const closureEvidence = getTournamentCompletionEvidence(torneo, partidos || [], equipos || []);
    if (!closureEvidence.verified) return res.status(409).json({
      code: 'TORNEO_CLOSURE_UNVERIFIED', error: 'Completa los resultados y la definición del campeón antes de cerrar el torneo.',
    });

    const { rankingRows, source } = buildFinalRankingForTorneo({
      equipos: equipos || [],
      partidos: partidos || [],
      tipoTorneo: torneo.tipo_torneo,
    });

    if (!rankingRows.length) {
      return res.status(400).json({
        error: 'No se pudo calcular el ranking final del torneo.',
        code: 'TORNEO_RANKING_EMPTY',
        tipo_torneo: torneo.tipo_torneo ?? null,
      });
    }

    // Already closed ledgers are immutable: a later global policy edit is not retroactive.
    if(torneo.estado==='finalizado') {
      const {data:saved,error:savedError}=await supabaseAdmin.from('tabla_puntos').select('torneo_id,equipo_id,posicion,puntos').eq('torneo_id',Number(id));
      if(savedError)throw savedError;
      if(!Array.isArray(saved)||saved.length!==equipos.length||new Set(saved.map(p=>Number(p.equipo_id))).size!==equipos.length||saved.some(p=>!equipos.some(e=>Number(e.id)===Number(p.equipo_id))))return res.status(409).json({code:'TORNEO_HISTORICAL_LEDGER_INCOMPLETE',error:'El cierre histórico no tiene una tabla completa confirmada. No se recalcularán sus puntos.'});
      return res.json({torneo,clasificacion:saved,status:'idempotent',source:'historical_ledger'});
    }
    const pointsPolicy=await loadPointsPolicy(supabaseAdmin);
    const puntosData = buildPointsRows(pointsPolicy,{torneoId:Number(id),nivel:torneo.nivel_torneo,rankingRows:rankingRows.map((row,index)=>({...row,posicion:index+1}))});

    if (isNationalRoster(torneo)) {
      const closed=await closeNationalTournament(supabaseAdmin,{torneo,equipos,puntosData,actorId:auth.user.id});
      await Promise.all(collectUserIdsFromEquipos(closed.equipos).map(userId=>actualizarRango(supabaseAdmin,userId).catch(()=>{})));
      return res.json({torneo:closed.torneo,clasificacion:puntosData,status:closed.status,participacion:'alineacion_convocada'});
    }

    // Ledger, team points and tournament state commit in one transaction (service-only RPC).
    // Ranking DTO contains display/statistics fields; the RPC persists only tabla_puntos columns.
    const persisted = await persistGenericTournamentClosure(supabaseAdmin, {
      torneo,
      equipos: equipos || [],
      puntosData,
      fechaFin: await resolveGenericTournamentClosureDate(supabaseAdmin, torneo, clock()),
    });
    if (persisted.status === 'conflict') return res.status(409).json({ code: 'TORNEO_CHANGED_RETRY', error: 'El torneo cambió. Actualiza antes de volver a cerrar.' });
    if (persisted.status === 'not_found') return res.status(404).json({ code: 'TORNEO_NOT_FOUND', error: 'Torneo no encontrado.' });
    if (persisted.status === 'historical_ledger_incomplete') return res.status(409).json({ code: 'TORNEO_HISTORICAL_LEDGER_INCOMPLETE', error: 'El cierre histórico no tiene una tabla completa confirmada. No se recalcularán sus puntos.' });
    // A concurrent request already closed it: return its immutable ledger without side effects.
    if (persisted.status === 'idempotent') return res.json({ torneo: persisted.torneo, clasificacion: persisted.tabla, status: 'idempotent', source: 'historical_ledger' });

    const torneoFinal = persisted.torneo;
    const jugadorUserIds = collectUserIdsFromEquipos(equipos);
    await Promise.all(
      jugadorUserIds.map((userId) =>
        actualizarRango(supabaseAdmin, userId).catch((err) =>
          console.warn(`⚠️ actualizarRango torneo ${id} user ${userId}:`, err.message),
        ),
      ),
    );

    // TODO: Auto-set jugadores_perfil.companero_habitual_id to the tournament doubles partner
    // when a match is completed (use the partner from that match for each player).

    console.log(`🏆 Torneo ${id} finalizado (${source}). ${puntosData.length} equipos clasificados.`);
    res.json({
      torneo: torneoFinal,
      clasificacion: puntosData,
    });
  } catch (err) {
    console.error('❌ Error finalizar torneo:', err.message);
    sendHttpError(res, err);
  }
});
}

export function mountTournamentResultRoute(app, { supabaseAdmin, requireTorneoAdminByTorneoId, sendHttpError }) {
app.post('/api/torneos/:torneoId/partidos/:partidoId/resultado', async (req, res) => {
  try {
    const { torneoId, partidoId } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, torneoId);
    if (!auth) return;

    const result = await cargarResultadoManualPartidoTorneo(supabaseAdmin, {
      torneoId,
      partidoId,
      body: req.body ?? {},
      actorId: auth.user?.id ?? null,
    });

    res.status(result.statusCode).json(result.body);
  } catch (err) {
    console.error('❌ Error POST resultado manual torneo:', err.message);
    sendHttpError(res, err);
  }
});
}
