import { pickPublicSedeRow } from '../../../utils/sedePublicSelect.js';

const SEDE_CONTEXT_SELECT = `
  id, nombre, moneda, deportes_disponibles, horario_apertura, horario_cierre
`;

function buildUserRef(userId) {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  return id.length <= 8 ? id : id.slice(0, 8);
}

async function fetchSedePublicContextPg(pgPool, sedeId) {
  if (!pgPool || sedeId == null) return null;

  const { rows } = await pgPool.query(
    `SELECT ${SEDE_CONTEXT_SELECT} FROM sedes WHERE id = $1 LIMIT 1`,
    [sedeId],
  );
  if (!rows[0]) return null;

  const picked = pickPublicSedeRow(rows[0]);
  return {
    sede_id: picked.id,
    sede_nombre: picked.nombre ?? null,
    moneda: picked.moneda ?? null,
    deportes_disponibles: picked.deportes_disponibles ?? null,
    horario_apertura: picked.horario_apertura ?? null,
    horario_cierre: picked.horario_cierre ?? null,
  };
}

export async function buildServerSideAiContext({ userId, params = {}, pgPool = null }) {
  const context = {
    user_ref: buildUserRef(userId),
  };

  if (params.screen) context.screen = params.screen;
  if (params.deporte) context.deporte = params.deporte;

  if (params.sede_id != null) {
    const sede = await fetchSedePublicContextPg(pgPool, params.sede_id);
    if (sede) {
      context.sede = sede;
    } else {
      context.sede_id = params.sede_id;
    }
  }

  return context;
}

export function buildUserPromptFromContext(message, context = {}) {
  const contextEntries = Object.entries(context ?? {}).filter(([, value]) => value != null && value !== '');
  if (contextEntries.length === 0) return message;

  const contextText = contextEntries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');

  return `Contexto del usuario:\n${contextText}\n\nConsulta:\n${message}`;
}
