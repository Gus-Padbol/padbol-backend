// Evidence of the existing knockout/grupos_knockout generators, not a new
// commercial match minimum. Unknown/legacy layouts are left unverified.
export function verifyIncentiveTournamentClosure(tournament, matches, results, pairIds) {
  const no = reason => ({ verified: false, reason });
  if (!['knockout', 'grupos_knockout'].includes(tournament.tipo_torneo)) return no('unsupported_or_legacy_layout');
  const hasGroup = row => row.grupo != null && String(row.grupo).trim() !== '';
  const bracket = matches.filter(row => !hasGroup(row));
  const groups = matches.filter(hasGroup);
  if (!bracket.length || bracket.some(row => !Number.isInteger(row.bracket_round) || row.bracket_round < 1
    || !Number.isInteger(row.bracket_position) || row.bracket_position < 1)) return no('bracket_metadata_missing');
  const first = bracket.filter(row => row.bracket_round === 1);
  const teamCount = first.length * 2;
  if (![4, 8, 16].includes(teamCount)) return no('bracket_structure_incomplete');
  const rounds = Math.log2(teamCount);
  if (bracket.length !== teamCount - 1) return no('bracket_structure_incomplete');
  const slots = new Map();
  for (const match of bracket) {
    const key = `${match.bracket_round}:${match.bracket_position}`;
    if (slots.has(key) || !results.has(Number(match.id))) return no('bracket_results_incomplete');
    slots.set(key, match);
  }
  const entrants = new Set(first.flatMap(row => [Number(row.equipo_a_id), Number(row.equipo_b_id)]));
  if (entrants.size !== teamCount || [...entrants].some(team => !pairIds.has(team))) return no('bracket_entrants_invalid');
  if (tournament.tipo_torneo === 'knockout' && (groups.length || entrants.size !== pairIds.size)) return no('bracket_entrants_incomplete');
  if (tournament.tipo_torneo === 'grupos_knockout') {
    if (!groups.length) return no('group_stage_missing');
    const groupsByName = new Map();
    for (const match of groups) {
      const key = String(match.grupo);
      if (!groupsByName.has(key)) groupsByName.set(key, []);
      groupsByName.get(key).push(match);
    }
    const grouped = new Set();
    for (const rows of groupsByName.values()) {
      const members = new Set(rows.flatMap(row => [Number(row.equipo_a_id), Number(row.equipo_b_id)]));
      const meetings = new Set(rows.map(row => [Number(row.equipo_a_id), Number(row.equipo_b_id)].sort((a,b) => a-b).join(':')));
      if (members.size < 2 || rows.length !== members.size * (members.size - 1) / 2 || meetings.size !== rows.length
        || [...members].some(team => !pairIds.has(team) || grouped.has(team))) return no('group_schedule_incomplete');
      members.forEach(team => grouped.add(team));
    }
    if (grouped.size !== pairIds.size) return no('group_entrants_incomplete');
  }
  let final;
  for (let round=1; round<=rounds; round+=1) {
    for (let position=1; position<=teamCount/(2 ** round); position+=1) {
      const match=slots.get(`${round}:${position}`);
      if (!match) return no('bracket_structure_incomplete');
      const score=results.get(Number(match.id));
      const winner=Number(score.sets_a > score.sets_b ? match.equipo_a_id : match.equipo_b_id);
      if (round===rounds) {
        if (match.partido_siguiente_id != null) return no('final_has_successor');
        final={verified:true,reason:'completed_linked_bracket',final_partido_id:Number(match.id),ganador_equipo_id:winner};
      } else {
        const next=slots.get(`${round+1}:${Math.ceil(position/2)}`);
        const slot=position%2===1 ? 'A' : 'B';
        if (!next || Number(match.partido_siguiente_id)!==Number(next.id) || match.partido_siguiente_slot!==slot
          || Number(slot==='A' ? next.equipo_a_id : next.equipo_b_id)!==winner) return no('bracket_advancement_inconsistent');
      }
    }
  }
  return final ?? no('final_missing');
}
