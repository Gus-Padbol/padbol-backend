/** Public DTO for scoreboard temporary players (no internal user_id). */
export function mapScoreboardJugadorTempPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    partido_id: row.partido_id,
    equipo: row.equipo,
    slot: row.slot,
    nombre: row.nombre ?? null,
    numero: row.numero ?? null,
    foto_url: row.foto_url ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export function mapScoreboardJugadoresTempPublic(rows) {
  return (rows ?? []).map(mapScoreboardJugadorTempPublicRow).filter(Boolean);
}
