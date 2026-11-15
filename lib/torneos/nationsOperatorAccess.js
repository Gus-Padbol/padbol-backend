import { randomUUID } from 'node:crypto';

export const NATIONS_OPERATOR_EVENT_ID = 57;
export const NATIONS_OPERATOR_ACTIONS = Object.freeze(['read','schedule','lineup','scoreboard','control']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function operatorError(code,status=403){return Object.assign(new Error(code),{code,status});}
export function operatorEventId(value){const id=Number(value);if(!Number.isSafeInteger(id)||id!==NATIONS_OPERATOR_EVENT_ID)throw operatorError('NATIONS_OPERATOR_SCOPE');return id;}
export async function assertNationsOperatorGrant(q,userId,torneoId,{action='read',lock=false}={}){
 const id=operatorEventId(torneoId);
 if(!UUID.test(String(userId||''))||!NATIONS_OPERATOR_ACTIONS.includes(action))throw operatorError('NATIONS_OPERATOR_SCOPE');
 const r=await q.query(`SELECT g.id,g.torneo_id,g.expires_at FROM nations_operator.grants g JOIN auth.users u ON u.id=g.user_id
 WHERE g.user_id=$1 AND g.torneo_id=$2 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND u.email_confirmed_at IS NOT NULL AND to_jsonb(u)->>'deleted_at' IS NULL
 AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false)
 ${lock?'FOR SHARE OF g,u':''}`,[userId,id]);
 if(r.rows.length!==1)throw operatorError('NATIONS_OPERATOR_SCOPE');
 return r.rows[0];
}
export async function canOperateNationsEvent(pool,user,torneo,{action='read'}={}){
 if(Number(torneo?.id)!==NATIONS_OPERATOR_EVENT_ID||!user?.id)return false;
 try{await assertNationsOperatorGrant(pool,user.id,torneo.id,{action});return true;}catch(e){if(e.code==='NATIONS_OPERATOR_SCOPE')return false;throw e;}
}
export async function assertOperatorGrantAdministrator(q,userId,{lock=false}={}){
 const r=await q.query(`SELECT u.id FROM auth.users u JOIN public.user_roles r ON r.user_id=u.id WHERE u.id=$1 AND r.role='super_admin'
 AND u.email_confirmed_at IS NOT NULL AND to_jsonb(u)->>'deleted_at' IS NULL
 AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false) ${lock?'FOR SHARE OF u,r':''}`,[userId]);
 if(r.rows.length!==1)throw operatorError('NATIONS_OPERATOR_ADMIN_REQUIRED');
}
export async function grantNationsOperator({pool,actorId,email,torneoId=57,expiresAt=null}){
 operatorEventId(torneoId);
 const normalized=String(email||'').trim().toLowerCase();
 if(normalized.length>254||!/^\S+@\S+\.\S+$/.test(normalized))throw operatorError('NATIONS_OPERATOR_EMAIL_INVALID',400);
 const c=await pool.connect();try{
  await c.query('BEGIN');await assertOperatorGrantAdministrator(c,actorId,{lock:true});
  const event=(await c.query('SELECT id,fecha_fin FROM public.torneos WHERE id=$1 FOR SHARE',[57])).rows[0];
  if(!event?.fecha_fin)throw operatorError('NATIONS_OPERATOR_EVENT_UNAVAILABLE',409);
  const candidates=(await c.query(`SELECT id,email,email_confirmed_at FROM auth.users u WHERE lower(email)=$1
    AND to_jsonb(u)->>'deleted_at' IS NULL
    AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false) FOR SHARE`,[normalized])).rows;
  if(candidates.length!==1||!candidates[0].email_confirmed_at)throw operatorError('NATIONS_OPERATOR_REGISTER_VERIFIED_ACCOUNT',409);
  const max=(await c.query("SELECT ($1::date+3)::timestamptz AS until",[event.fecha_fin])).rows[0].until;
  const expiry=expiresAt==null?new Date(max):new Date(expiresAt);
  if(!Number.isFinite(expiry.getTime())||expiry<=new Date()||expiry>new Date(max))throw operatorError('NATIONS_OPERATOR_EXPIRY_INVALID',400);
  const result=await c.query(`INSERT INTO nations_operator.grants(id,user_id,torneo_id,granted_by,expires_at) VALUES($1,$2,57,$3,$4)
   ON CONFLICT(user_id,torneo_id) DO UPDATE SET granted_by=EXCLUDED.granted_by,expires_at=EXCLUDED.expires_at,revoked_at=NULL,updated_at=clock_timestamp()
   RETURNING id,torneo_id,user_id,expires_at,revoked_at`,[randomUUID(),candidates[0].id,actorId,expiry.toISOString()]);
  await c.query('INSERT INTO nations_operator.audit(actor_id,torneo_id,action,grant_id) VALUES($1,57,$2,$3)',[actorId,'grant',result.rows[0].id]);
  await c.query('COMMIT');return {...result.rows[0],email:candidates[0].email};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function revokeNationsOperator({pool,actorId,grantId}){
 if(!UUID.test(String(grantId||'')))throw operatorError('NATIONS_OPERATOR_GRANT_INVALID',400);
 const c=await pool.connect();try{await c.query('BEGIN');await assertOperatorGrantAdministrator(c,actorId,{lock:true});
  const result=await c.query('UPDATE nations_operator.grants SET revoked_at=coalesce(revoked_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1 AND torneo_id=57 RETURNING id,torneo_id,revoked_at',[grantId]);
  if(result.rows.length!==1)throw operatorError('NATIONS_OPERATOR_GRANT_NOT_FOUND',404);
  await c.query('INSERT INTO nations_operator.audit(actor_id,torneo_id,action,grant_id) VALUES($1,57,$2,$3)',[actorId,'revoke',grantId]);
  await c.query('COMMIT');return result.rows[0];
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
