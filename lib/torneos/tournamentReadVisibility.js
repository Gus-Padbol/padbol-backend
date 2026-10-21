import {canReadQaCatalogRow} from '../qaCatalogVisibility.js';
const COLLECTION_ROUTES = new Set(['mis-inscripciones', 'finalizados', 'resumen-stats']);
/** Parent visibility applies to every nested read, before any child rows are queried. */
export function createTournamentReadVisibility({db,getAudience,onError} = {}) {
  if (!db || typeof getAudience !== 'function') throw new Error('Tournament visibility dependencies required');
  return async (req,res,next) => {
    if (!['GET','HEAD'].includes(req.method)) return next();
    const raw = String(req.params?.torneoId || '');
    if (COLLECTION_ROUTES.has(raw.toLowerCase())) return next();
    const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({error:'Identificador de torneo inválido.'});
    try {
      const {data,error} = await db.from('torneos').select('id,sede_id,es_prueba').eq('id',id).maybeSingle();
      if (error) throw error;
      if (!data || !canReadQaCatalogRow(data,data.es_prueba === true ? await getAudience(req) : null)) return res.status(404).json({error:'Torneo no encontrado'});
      return next();
    } catch (error) {
      if (onError) return onError(res,error);
      return res.status(503).json({error:'No se pudo verificar el acceso al torneo.'});
    }
  };
}
