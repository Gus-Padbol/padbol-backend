/** Read-only projection from eligibility frozen at closure; never rewrites a roster. */
export async function projectVerifiedTournamentRankingTeams(db, teams = []) {
  const affected = teams.filter(t => Array.isArray(t.jugadores) && t.jugadores.some(p => p.participante_id));
  if (!affected.length) return teams;
  const result = await db.from('torneo_participante_ranking_cierres').select('torneo_id,equipo_id,participantes').in('equipo_id', affected.map(t => t.id));
  if (result.error || !Array.isArray(result.data)) throw new Error('No se pudo verificar la identidad de los participantes del ranking.');
  const snapshots = new Map(result.data.map(row => [`${row.torneo_id}:${row.equipo_id}`, row]));
  return teams.map(team => {
    if (!affected.includes(team)) return team;
    const snapshot = snapshots.get(`${team.torneo_id}:${team.id}`);
    // Missing snapshots never fall back to a mutable link, a name or a free UUID.
    const entries = Array.isArray(snapshot?.participantes) ? snapshot.participantes : [];
    const eligible = new Map(entries.filter(p => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.user_id || '')).map(p => [String(p.participante_id), p.user_id]));
    const declared = new Set((team.participantes_ranking || []).map(String));
    return { ...team, registry_ranking_verified: true, jugadores: team.jugadores.flatMap(player => {
      const userId = eligible.get(String(player.participante_id));
      if (!userId || (team.modalidad_plantel === 'selecciones' && !declared.has(String(userId)))) return [];
      return [{ ...player, user_id: userId, id: userId }];
    }) };
  });
}
