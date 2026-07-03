export const KNOCKOUT_BRACKET_SIZES = [4, 8, 16];

const KNOCKOUT_ROUND_LABELS = {
  4: ['semifinal', 'final'],
  8: ['cuartos', 'semifinal', 'final'],
  16: ['octavos', 'cuartos', 'semifinal', 'final'],
};

export function assertKnockoutBracketTeamCount(count) {
  if (!KNOCKOUT_BRACKET_SIZES.includes(count)) {
    throw Object.assign(
      new Error(`Eliminación directa requiere exactamente 4, 8 o 16 equipos (recibidos: ${count})`),
      { status: 400, code: 'knockout_invalid_team_count' },
    );
  }
}

export function getKnockoutRoundLabel({ totalTeams, bracketRound }) {
  const labels = KNOCKOUT_ROUND_LABELS[Number(totalTeams)] ?? [];
  const idx = Number(bracketRound) - 1;
  return labels[idx] ?? null;
}

function groupPartidosByBracketRound(partidos) {
  const byRound = new Map();
  for (const partido of partidos) {
    const round = partido.bracket_round;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(partido);
  }
  for (const roundPartidos of byRound.values()) {
    roundPartidos.sort((a, b) => a.bracket_position - b.bracket_position);
  }
  return byRound;
}

/**
 * Genera todas las filas de partidos para una llave knockout completa (sin IDs ni links).
 */
export function buildKnockoutBracketMatches({
  equipos,
  torneoId,
  sedeId,
  shuffle = true,
}) {
  assertKnockoutBracketTeamCount(equipos.length);

  const tid = parseInt(torneoId, 10);
  const ordered = shuffle ? [...equipos].sort(() => Math.random() - 0.5) : [...equipos];
  const numRounds = KNOCKOUT_ROUND_LABELS[equipos.length].length;
  const partidos = [];

  for (let roundIdx = 0; roundIdx < numRounds; roundIdx += 1) {
    const bracketRound = roundIdx + 1;
    const matchesInRound = equipos.length / (2 ** bracketRound);

    for (let position = 1; position <= matchesInRound; position += 1) {
      let equipoAId = null;
      let equipoBId = null;

      if (roundIdx === 0) {
        const base = (position - 1) * 2;
        equipoAId = ordered[base].id;
        equipoBId = ordered[base + 1].id;
      }

      partidos.push({
        torneo_id: tid,
        sede_id: sedeId || null,
        equipo_a_id: equipoAId,
        equipo_b_id: equipoBId,
        estado: 'pendiente',
        grupo: null,
        ronda: bracketRound,
        bracket_round: bracketRound,
        bracket_position: position,
      });
    }
  }

  return partidos;
}

/**
 * Calcula updates de partido_siguiente_id/slot para partidos ya insertados (con id).
 * @returns {Array<{ id: number, partido_siguiente_id: number, partido_siguiente_slot: 'A' | 'B' }>}
 */
export function linkBracketMatches(insertedPartidos) {
  const byRound = groupPartidosByBracketRound(insertedPartidos);
  const roundNumbers = [...byRound.keys()].sort((a, b) => a - b);
  const updates = [];

  for (let roundIdx = 0; roundIdx < roundNumbers.length - 1; roundIdx += 1) {
    const sources = byRound.get(roundNumbers[roundIdx]);
    const destinos = byRound.get(roundNumbers[roundIdx + 1]);

    sources.forEach((source, sourceIndex) => {
      const destinoIndex = Math.floor(sourceIndex / 2);
      const slot = sourceIndex % 2 === 0 ? 'A' : 'B';
      const destino = destinos[destinoIndex];
      if (!source?.id || !destino?.id) return;

      updates.push({
        id: source.id,
        partido_siguiente_id: destino.id,
        partido_siguiente_slot: slot,
      });
    });
  }

  return updates;
}

/**
 * Aplica links en memoria (útil para tests y respuesta API).
 */
export function mergeBracketLinks(insertedPartidos, linkUpdates) {
  const byId = new Map(insertedPartidos.map((p) => [p.id, { ...p }]));
  for (const patch of linkUpdates) {
    const current = byId.get(patch.id);
    if (current) Object.assign(current, patch);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.bracket_round !== b.bracket_round) return a.bracket_round - b.bracket_round;
    return a.bracket_position - b.bracket_position;
  });
}
