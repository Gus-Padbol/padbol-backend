/** Read-only projection of official FIPA history by canonical name+country. No claims, IDs or account links. */
const normName = (value) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const normCountry = (value) => String(value ?? '').trim().toUpperCase();

export function resolveNationsParticipantHistory({ participants = [], officialPlayers = [] } = {}) {
  const byKey = new Map();
  for (const player of officialPlayers) {
    const key = `${normName(player?.nombre_completo ?? player?.name)}|${normCountry(player?.pais ?? player?.country)}`;
    if (!key.startsWith('|') && !byKey.has(key)) byKey.set(key, []);
    if (!key.startsWith('|')) byKey.get(key).push(player);
  }
  return participants.map((participant) => {
    const key = `${normName(participant?.nombre ?? participant?.name)}|${normCountry(participant?.pais ?? participant?.country)}`;
    const matches = byKey.get(key) || [];
    if (matches.length === 1) {
      const p = matches[0];
      return { status: 'matched', puntos: Number.isFinite(Number(p.puntos)) ? Number(p.puntos) : 0, posicion: Number.isFinite(Number(p.posicion)) ? Number(p.posicion) : null };
    }
    if (matches.length > 1) return { status: 'ambiguous', puntos: null, posicion: null };
    return { status: 'zero', puntos: 0, posicion: null };
  });
}
