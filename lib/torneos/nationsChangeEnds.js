const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const gameCount=v=>Number.isSafeInteger(v)&&v>=0;

/** Only the server-owned score at a completed odd game opens a change of ends.
 * Set-boundary 7-6 is odd too; after the next set starts use its own game count. */
export function substitutionWindow(row) {
  const history=Array.isArray(row?.historial_sets)?row.historial_sets:null;
  let games=gameCount(row?.games_a)&&gameCount(row?.games_b)?row.games_a+row.games_b:null;
  let setNumber=history?history.length+1:null;
  if(games===0&&history?.length) {
    const last=history.at(-1);
    games=last&&gameCount(last.a)&&gameCount(last.b)?last.a+last.b:null;
    setNumber=history.length;
  }
  const allowed=row?.estado==='en_curso'&&row.cronometro_pausado!==true&&row.es_tiebreak===false&&row.score_a===0&&row.score_b===0&&history!==null&&games!==null&&games>0&&games%2===1;
  return {allowed,reason:allowed?null:'CHANGE_ENDS_REQUIRED',completed_games:games,set_number:setNumber};
}
export function assertChangeEndsWindow(row) {
  if(!substitutionWindow(row).allowed)fail('CHANGE_ENDS_REQUIRED');
}

/** A short shared row lock supplies one authoritative score snapshot; POST still rechecks it. */
export async function readSubstitutionWindow(pool,scoreboardId) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const result=await client.query('SELECT estado,cronometro_pausado,es_tiebreak,score_a,score_b,games_a,games_b,historial_sets FROM public.scoreboard_partidos WHERE id=$1 FOR SHARE',[scoreboardId]);
    if(!result.rows[0])fail('SCOREBOARD_NOT_FOUND',404);
    const window=substitutionWindow(result.rows[0]);
    await client.query('COMMIT');
    return window;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}

/** Validate against the initial pair before appending either event; never half a batch. */
export function substitutionSwaps(body,state) {
  if(!Object.hasOwn(body,'swaps'))return [{outId:body.outId,inId:body.inId}];
  if(Object.hasOwn(body,'outId')||Object.hasOwn(body,'inId')||!Array.isArray(body.swaps)||body.swaps.length<1||body.swaps.length>2||body.swaps.some(s=>!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['outId','inId'].includes(k))||typeof s.outId!=='string'||typeof s.inId!=='string')||new Set(body.swaps.map(s=>s.outId)).size!==body.swaps.length||new Set(body.swaps.map(s=>s.inId)).size!==body.swaps.length)fail('SUBSTITUTION_BATCH_INVALID',400);
  for(const s of body.swaps) {
    if(!state.active.includes(s.outId))fail('OUT_NOT_ACTIVE',400);
    if(state.active.includes(s.inId))fail('IN_ALREADY_ACTIVE',400);
    if(!state.roster.includes(s.inId))fail('IN_NOT_IN_LINEUP',400);
  }
  return body.swaps;
}
