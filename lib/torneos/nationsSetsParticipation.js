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
  return new Set(sets);
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
    const pair=event.teams?.[teamId]; const set=Number(event.set);
    if(!Array.isArray(pair)||pair.length!==2||new Set(pair).size!==2||pair.some(id=>!roster.includes(String(id))))throw fail('GAME_LINEUP_INVALID','Pareja fuera del plantel oficial.');
    if(!Number.isSafeInteger(set)||set<1)throw fail('GAME_SET_INVALID','Set del game inválido.');
    if(!bySet.has(set))bySet.set(set,[]); bySet.get(set).push(pair.map(String));
  }
  const counts=Object.fromEntries(roster.map(id=>[id,0])); let teamTotalSets=0;
  for(const [set,pairs] of bySet){
    if(!completed.has(set))continue; // only officially completed sets
    if(pairs.some(pair=>pair.join('|')!==pairs[0].join('|'))) throw fail('MID_SET_PAIR_CHANGE','Cambio de pareja dentro de un set; elegibilidad no inferida.');
    teamTotalSets+=1;
    for(const id of pairs[0])counts[id]+=1;
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
