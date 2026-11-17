import {createHash} from 'node:crypto';

const fail=(code,message)=>Object.assign(new Error(message||code),{code});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const digestParticipation=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function completedSetNumbers(scoreboard) {
  if (!Array.isArray(scoreboard?.historial_sets)) throw fail('SET_HISTORY_REQUIRED','Falta historial_sets oficial.');
  const sets = scoreboard.historial_sets.map((set,index) => {
    const n=Number(set?.set ?? index+1); const a=Number(set?.a), b=Number(set?.b);
    if (!Number.isSafeInteger(n)||n!==index+1||!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<0||a===b) throw fail('SET_HISTORY_INVALID','Historial de sets inválido.');
    return n;
  });
  if (new Set(sets).size!==sets.length) throw fail('SET_HISTORY_INVALID','Sets repetidos.');
  return new Map(scoreboard.historial_sets.map((set,index)=>[index+1,{a:Number(set.a),b:Number(set.b),type:set.type??'normal',points_a:set.points_a,points_b:set.points_b}]));
}

/** Official games ledger projection, with reversals applied and no inferred players. */
function activeGames(aggregate) {
  if (aggregate?.finalization?.status!=='completed') throw fail('FINALIZATION_NOT_COMPLETED','El partido no tiene finalización oficial completada.');
  const ledger=aggregate?.gamesLedger;
  if (!ledger||ledger.version!==1||!Array.isArray(ledger.events)||!Array.isArray(ledger.active)||Number(ledger.total)!==ledger.active.length) throw fail('GAMES_LEDGER_INVALID','Games ledger inválido.');
  const effective=new Map(),seen=new Set();
  for(const event of ledger.events){
    if(!event||typeof event!=='object'||Array.isArray(event))throw fail('GAME_EVENT_INVALID','Evento de game inválido.');
    if(typeof event.historyId!=='string'||!event.historyId)throw fail('GAME_EVENT_INVALID','historyId requerido.');
    if(event.type==='game'){
      if(seen.has(event.historyId)||Number(event.ordinal)!==effective.size+1)throw fail('GAME_EVENT_INVALID','Orden de games inválido.');
      seen.add(event.historyId);effective.set(event.historyId,event);
    }else if(event.type==='reversal'){
      if([...effective.keys()].at(-1)!==event.historyId)throw fail('GAME_REVERSAL_INVALID','Reversal fuera de orden.');
      effective.delete(event.historyId);
    }else throw fail('GAME_EVENT_INVALID','Tipo de evento inválido.');
  }
  if(JSON.stringify([...effective.keys()])!==JSON.stringify(ledger.active))throw fail('GAMES_LEDGER_INVALID','Active no coincide con eventos.');
  return [...effective.values()];
}

function playerSetsForTeam({aggregate, scoreboard, teamId, minimumSets = 1}) {
  const completed=completedSetNumbers(scoreboard); const games=activeGames(aggregate);
  const state=aggregate?.states?.[teamId]; if(!state||!state.lineup)throw fail('TEAM_STATE_MISSING','Falta estado oficial del equipo.');
  const roster=[...(state.lineup.iniciales||[]),...(state.lineup.suplentes||[])].map(String);
  if(roster.length<2||roster.length>8||new Set(roster).size!==roster.length)throw fail('ROSTER_INVALID','Plantel inválido.');
  const bySet=new Map();
  for(const event of games){
    const pair=event.teams?.[teamId]; const set=Number(event.set); const number=Number(event.number);
    if(!Array.isArray(pair)||pair.length!==2||new Set(pair).size!==2||pair.some(id=>!roster.includes(String(id))))throw fail('GAME_LINEUP_INVALID','Pareja fuera del plantel oficial.');
    if(!Number.isSafeInteger(set)||set<1||!Number.isSafeInteger(number)||number<1)throw fail('GAME_SET_INVALID','Set/number del game inválido.');
    if(!bySet.has(set))bySet.set(set,[]); bySet.get(set).push({pair:pair.map(String),number});
  }
  // Every completed set must have exactly its official games (a+b), numbered 1..total with no gaps.
  for(const [set,row] of completed){
    const gamesInSet=(bySet.get(set)||[]).sort((x,y)=>x.number-y.number);
    // A decisive super tie-break is one official ledger game even when its
    // history stores points (10-9). Normal sets still require a+b games.
    const expected=row.type==='super_tiebreak'?1:row.a+row.b;
    if(expected<1||gamesInSet.length!==expected)throw fail('SET_GAME_COUNT_MISMATCH',`Set ${set}: ${gamesInSet.length} games, esperados ${expected}.`);
    if(gamesInSet.some((game,index)=>game.number!==index+1))throw fail('SET_GAME_SEQUENCE_INVALID',`Set ${set}: numeración incompleta o fuera de orden.`);
  }
  const counts=Object.fromEntries(roster.map(id=>[id,0])); let teamTotalSets=0;
  for(const [set,pairs] of bySet){
    const stable=pairs.map(game=>[...game.pair].sort().join('|'));
    if(!completed.has(set))continue;
    teamTotalSets+=1;
    // Odd-game/partial appearance: only a player present in EVERY game of
    // the completed set earns that set. The odd-game rule itself remains in
    // the marker/control layer; this projection never infers a partial set.
    const common=stable[0].split('|').filter(id=>stable.every(pair=>pair.split('|').includes(id)));
    for(const id of common)counts[id]+=1;
  }
  const maxPlayerSets=Math.max(0,...Object.values(counts));
  const players=roster.map(id=>({id,playerSets:counts[id],minimumMet:counts[id]>=minimumSets}));
  return {teamId:String(teamId),teamTotalSets,maxPlayerSets,minimumSets,minimumMet:teamTotalSets>=minimumSets,players};
}

export function buildSetsParticipation({aggregate,scoreboard,minimumSets=1}) {
  if(!Number.isSafeInteger(Number(minimumSets))||Number(minimumSets)<1)throw fail('MINIMUM_SETS_INVALID','Mínimo de sets inválido.');
  const ids=Object.keys(aggregate?.states||{}); if(ids.length!==2)throw fail('TEAM_STATE_MISSING','Se requieren dos equipos oficiales.');
  const teams=ids.map(teamId=>playerSetsForTeam({aggregate,scoreboard,teamId,minimumSets:Number(minimumSets)}));
  const sourceRevision=Number(aggregate?.finalization?.revision ?? aggregate?.revision);
  if(!Number.isSafeInteger(sourceRevision)||sourceRevision<0)throw fail('SOURCE_REVISION_REQUIRED','sourceRevision inválido.');
  const payload={sourceRevision,minimumSets:Number(minimumSets),teams};
  return {...payload,digest:digestParticipation(payload)};
}
