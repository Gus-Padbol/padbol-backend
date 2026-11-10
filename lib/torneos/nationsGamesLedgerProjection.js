/** Read-only projection of the durable games ledger. Clock participation remains separate. */
export function projectGamesLedger(aggregate, teamId) {
 const pending=reason=>({status:'unconfirmed',reason,basis:'completed_games',players:null,totalGames:null});
 const state=aggregate?.states?.[teamId];if(!state)return pending('TEAM_STATE_MISSING');
 if(!Array.isArray(state.lineup?.iniciales)||!Array.isArray(state.lineup?.suplentes))return pending('ROSTER_INVALID');
 const roster=[...(state.lineup?.iniciales||[]),...(state.lineup?.suplentes||[])];
 if(roster.length<2||roster.length>8||new Set(roster).size!==roster.length)return pending('ROSTER_INVALID');
 const ledger=aggregate?.gamesLedger;if(!ledger)return pending('GAME_BASELINE_MISSING');
 if(ledger.version!==1||!Array.isArray(ledger.events)||!Array.isArray(ledger.active)||ledger.total!==ledger.active.length)return pending('GAME_LEDGER_INVALID');
 const effective=new Map(),seen=new Set();
 for(const event of ledger.events){
   if(!event || typeof event!=='object' || Array.isArray(event))return pending('GAME_EVENT_INVALID');
   if(typeof event.historyId!=='string'||!event.historyId)return pending('GAME_EVENT_INVALID');
   if(event.type==='game'){
     if(seen.has(event.historyId)||event.ordinal!==effective.size+1)return pending('GAME_EVENT_INVALID');
     seen.add(event.historyId);effective.set(event.historyId,event);
   }else if(event.type==='reversal'){
     if([...effective.keys()].at(-1)!==event.historyId)return pending('GAME_REVERSAL_INVALID');
     effective.delete(event.historyId);
   }else return pending('GAME_EVENT_INVALID');
 }
 if(JSON.stringify([...effective.keys()])!==JSON.stringify(ledger.active))return pending('GAME_LEDGER_INVALID');
 const totals=Object.fromEntries(roster.map(id=>[id,0]));
 for(const event of effective.values()){
   const pair=event.teams?.[teamId];
   if(!Array.isArray(pair)||pair.length!==2||new Set(pair).size!==2||pair.some(id=>!Object.hasOwn(totals,id)))return pending('GAME_LINEUP_INVALID');
   for(const id of pair)totals[id]++;
 }
 return {status:['closed','corrected'].includes(state.status)?'confirmed':'provisional',basis:'completed_games',totalGames:ledger.total,
   players:roster.map(id=>({id,gamesPlayed:totals[id],percentage:ledger.total?100*totals[id]/ledger.total:null}))};
}
