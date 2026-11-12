import {generateControlToken,hashControlToken} from './scoreboardControlToken.js';
const fail=code=>{throw Object.assign(new Error(code),{code,status:403});};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso=value=>{const d=new Date(value);return value!=null&&Number.isFinite(d.getTime())?d.toISOString():null;};
async function verifiedIssuer(q,id,sedeId,lock){
  if(!uuid.test(id||''))fail('CONTROL_TOKEN_ISSUER_REQUIRED');
  const rows=(await q.query(`SELECT u.id,u.email_confirmed_at,to_jsonb(u)->>'deleted_at' AS deleted_at,
    coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false) AS banned,r.role,r.sede_id
    FROM auth.users u JOIN public.user_roles r ON r.user_id=u.id WHERE u.id=$1${lock?' FOR SHARE OF u,r':''}`,[id])).rows;
  const user=rows[0];
  if(rows.length!==1||!user.email_confirmed_at||user.deleted_at||user.banned)fail('CONTROL_TOKEN_ISSUER_UNAVAILABLE');
  if(user.role!=='super_admin'&&(!['admin_club','admin_sede'].includes(user.role)||user.sede_id==null||Number(user.sede_id)!==Number(sedeId)))fail('CONTROL_TOKEN_ISSUER_FORBIDDEN');
  return String(user.id);
}
/** Read only the persisted exact-board/exact-hash issuer, never a request-body UUID or a fallback administrator. */
export async function readNationsControlDelegation(q,row,{lock=false,expected=null,actorId=null}={}){
  if(!row||row.control_token_revoked_at!=null||!row.control_token_hash)fail('CONTROL_TOKEN_REVOKED');
  if(actorId&&actorId!=='control-token:'+row.control_token_hash)fail('CONTROL_TOKEN_SCOPE');
  const rows=(await q.query(`SELECT issuer_user_id,issued_at FROM nations_marker_private.nations_control_token_issuer
    WHERE scoreboard_id=$1 AND token_hash=$2${lock?' FOR SHARE':''}`,[row.id,row.control_token_hash])).rows;
  if(rows.length!==1||iso(rows[0].issued_at)!==iso(row.control_token_created_at)||!iso(row.control_token_created_at))fail('CONTROL_TOKEN_ISSUER_REQUIRED');
  const issuerId=await verifiedIssuer(q,String(rows[0].issuer_user_id),row.sede_id,lock);
  const delegation={issuerId,tokenHash:row.control_token_hash,tokenCreatedAt:iso(row.control_token_created_at)};
  if(expected&&Object.keys(delegation).some(key=>delegation[key]!==expected[key]))fail('CONTROL_TOKEN_DELEGATION_CHANGED');
  return delegation;
}
/** Real authenticated issuance. No backfill: proof and token are committed together while issuer/venue remain authorized. */
export async function issueNationsControlToken({pool,scoreboardId,issuerId}){
  const c=await pool.connect();try{
    await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0))");
    const row=(await c.query(`SELECT s.id,s.sede_id,s.torneo_id,m.id AS linked_match_id,m.torneo_id AS linked_torneo_id,t.sede_id AS tournament_sede_id,t.modalidad_plantel,t.deporte FROM public.scoreboard_partidos s
      LEFT JOIN public.partidos m ON m.id=s.partido_torneo_id LEFT JOIN public.torneos t ON t.id=coalesce(m.torneo_id,s.torneo_id)
      WHERE s.id=$1 FOR UPDATE OF s`,[scoreboardId])).rows[0];
    if(!row)fail('CONTROL_TOKEN_SCOPE');
    if(row.torneo_id!=null&&row.linked_torneo_id!=null&&String(row.torneo_id)!==String(row.linked_torneo_id))fail('CONTROL_TOKEN_SCOPE');
    if(row.modalidad_plantel!=='selecciones'||row.deporte!=='padbol'){await c.query('COMMIT');return null;}
    if(row.linked_match_id==null||row.tournament_sede_id==null||String(row.sede_id)!==String(row.tournament_sede_id))fail('CONTROL_TOKEN_SCOPE');
    await verifiedIssuer(c,issuerId,row.sede_id,true);
    const token=generateControlToken(),hash=hashControlToken(token);const ts=(await c.query('SELECT clock_timestamp() AS ts')).rows[0].ts;
    await c.query('UPDATE public.scoreboard_partidos SET control_token_hash=$2,control_token_created_at=$3,control_token_revoked_at=NULL,updated_at=clock_timestamp() WHERE id=$1',[scoreboardId,hash,ts]);
    await c.query('INSERT INTO nations_marker_private.nations_control_token_issuer(scoreboard_id,token_hash,issuer_user_id,issued_at)VALUES($1,$2,$3,$4)',[scoreboardId,hash,issuerId,ts]);
    await c.query('COMMIT');return {controlToken:token,controlTokenCreatedAt:iso(ts)};
  }catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}
}
