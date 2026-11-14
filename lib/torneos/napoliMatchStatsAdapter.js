/**
 * Pure adapter: observed team/player evolution only. No provider, no shots,
 * no causal attribution. Events/intervals must carry valid timestamps.
 */
function ts(value){const n=Date.parse(value);return Number.isFinite(n)?n:null;}
export function validateMatchTracking({events=[],intervals=[],substitutions=[]}={}) {
  const errors=[]; if(!Array.isArray(events)||!Array.isArray(intervals)||!Array.isArray(substitutions))return {ok:false,errors:['ARRAYS_REQUIRED']};
  if(!events.length)errors.push('EVENTS_REQUIRED');
  let prev=-Infinity;const seqs=new Set();
  for(const e of events){if(!e||typeof e!=='object'){errors.push('EVENT_INVALID');continue;}const t=ts(e.ts);if(t==null||!Number.isSafeInteger(Number(e.seq)))errors.push('EVENT_TIME_OR_SEQ_INVALID');if(seqs.has(Number(e.seq)))errors.push('EVENT_SEQ_DUPLICATE');seqs.add(Number(e.seq));if(t!=null&&t<prev)errors.push('EVENTS_NOT_ORDERED');if(t!=null)prev=t;if(!['A','B'].includes(e.team))errors.push('EVENT_TEAM_INVALID');for(const k of ['games_a','games_b','sets_a','sets_b'])if(e[k]!=null&&(!Number.isFinite(Number(e[k]))||Number(e[k])<0))errors.push('SCORE_INVALID');}
  const byPlayer=new Map();
  for(const i of intervals){if(!i||typeof i!=='object'){errors.push('INTERVAL_INVALID');continue;}if(!i.player_id||String(i.player_id).includes('@')||!['A','B'].includes(i.team)||ts(i.from_ts)==null||ts(i.to_ts)==null||ts(i.to_ts)<ts(i.from_ts)){errors.push('INTERVAL_INVALID');continue;}const list=byPlayer.get(i.player_id)??[];for(const other of list){if(ts(i.from_ts)<=ts(other.to_ts)&&ts(i.to_ts)>=ts(other.from_ts))errors.push('INTERVAL_OVERLAP');}list.push(i);byPlayer.set(i.player_id,list);}
  for(const s of substitutions){if(!s||typeof s!=='object'){errors.push('SUBSTITUTION_INVALID');continue;}if(!s.player_out_id||!s.player_in_id||!['A','B'].includes(s.team)||ts(s.ts)==null)errors.push('SUBSTITUTION_INVALID');}
  return {ok:errors.length===0,errors:[...new Set(errors)]};
}
export function buildObservedMatchStats({events=[],intervals=[],substitutions=[]}={}) {
  const validation=validateMatchTracking({events,intervals,substitutions});
  if(!validation.ok)return {ok:false,errors:validation.errors,team_totals:null,player_observed:null};
  const team_totals={A:{points:0,games:0,sets:0},B:{points:0,games:0,sets:0}};
  for(const e of events){team_totals[e.team].points+=1; if(e.games_a!=null)team_totals.A.games=Number(e.games_a); if(e.games_b!=null)team_totals.B.games=Number(e.games_b); if(e.sets_a!=null)team_totals.A.sets=Number(e.sets_a); if(e.sets_b!=null)team_totals.B.sets=Number(e.sets_b);}
  const playerMap=new Map();
  for(const i of intervals){playerMap.set(i.player_id,{player_id:i.player_id,team:i.team,points_observed:0,intervals:0});}
  for(const e of events){
    const at=ts(e.ts);
    for(const i of intervals){if(i.team!==e.team)continue;const from=ts(i.from_ts),to=ts(i.to_ts);if(at>=from&&at<=to){const row=playerMap.get(i.player_id);row.points_observed+=1;row.intervals+=1;}}
  }
  return {ok:true,errors:[],team_totals,player_observed:[...playerMap.values()],substitutions_count:substitutions.length,source:'scoreboard_events+on_court_intervals'};
}
