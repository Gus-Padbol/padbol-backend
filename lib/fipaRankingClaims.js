import crypto from 'node:crypto';
export const claimError=(message,status=400)=>Object.assign(new Error(message),{status});
export const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
export function validateInvitation(body={}){
 const email=String(body.destino_valor||'').trim().toLowerCase();
 const note=String(body.justificacion||'').trim();
 if(body.destino_tipo!=='email'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>240)throw claimError('Indica el correo de la cuenta del jugador.');
 if(body.identidad_verificada!==true||note.length<10||note.length>500)throw claimError('Verifica la identidad e indica cómo la comprobaste (10 a 500 caracteres).');
 return {email,note};
}
export function validateClaimToken(value){if(typeof value!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(value))throw claimError('La invitación no es válida.',404);return tokenHash(value);}
export function assertClaimAccount(invitation,user){
 if(!user?.id||!user.email_confirmed_at)throw claimError('Confirma el correo de tu cuenta antes de continuar.',403);
 if(String(user.email||'').trim().toLowerCase()!==invitation.email)throw claimError('Ingresa con la cuenta cuyo correo indicaste al coordinador. Esta invitación corresponde a otra cuenta.',403);
}
export function createFipaClaimStore(pool){
 async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 return {
  requests:async userId=>(await pool.query('select * from public.fipa_ranking_requests'+(userId?' where user_id=$1':'')+' order by created_at desc',userId?[userId]:[])).rows,
  async request(player,user,confirmed){
   if(!user.email_confirmed_at||!user.email)throw claimError('Confirma el correo de tu cuenta antes de continuar.',403);
   if(confirmed!==true)throw claimError('Confirma que este es tu perfil del ranking.');
   return tx(async c=>{
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa-account:'+user.id]);
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa:'+player.source_key]);
    if((await c.query('select 1 from public.fipa_ranking_links where source_key=$1 or user_id=$2',[player.source_key,user.id])).rowCount)throw claimError('El perfil o tu cuenta ya están vinculados. Solicita revisión a coordinación.',409);
    const previous=(await c.query('select * from public.fipa_ranking_requests where user_id=$1',[user.id])).rows;
    const same=previous.find(r=>r.source_key===player.source_key);
    if(same?.state==='pending')return same;
    if(same)throw claimError('Esta solicitud ya fue revisada. Contacta a coordinación para corregirla.',409);
    if(previous.some(r=>r.state==='pending'))throw claimError('Ya tienes una solicitud pendiente de revisión.',409);
    const row=(await c.query('insert into public.fipa_ranking_requests(source_key,user_id,email) values($1,$2,$3) returning *',[player.source_key,user.id,user.email.toLowerCase()])).rows[0];
    await c.query("insert into public.fipa_ranking_claim_audit(source_key,action,actor_id,request_id) values($1,'request',$2,$3)",[player.source_key,user.id,row.id]);return row;
   });
  },
  async review(id,actor,decision,note){
   if(!/^[0-9a-f-]{36}$/i.test(id)||!['approved','rejected'].includes(decision))throw claimError('Solicitud o decisión no válida.');
   note=String(note||'').trim();if(note.length<10||note.length>500)throw claimError('Indica cómo verificaste la identidad o el motivo del rechazo (10 a 500 caracteres).');
   return tx(async c=>{
    const candidate=(await c.query('select * from public.fipa_ranking_requests where id=$1',[id])).rows[0];if(!candidate)throw claimError('Solicitud no encontrada.',404);
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa-account:'+candidate.user_id]);
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa:'+candidate.source_key]);
    const row=(await c.query('select * from public.fipa_ranking_requests where id=$1 for update',[id])).rows[0];
    if(row.state!=='pending')throw claimError('La solicitud ya fue revisada.',409);
    if(decision==='approved'){
     if((await c.query('select 1 from public.fipa_ranking_links where source_key=$1 or user_id=$2',[row.source_key,row.user_id])).rowCount)throw claimError('El perfil o la cuenta ya están vinculados.',409);
     await c.query('insert into public.fipa_ranking_links(source_key,user_id) values($1,$2)',[row.source_key,row.user_id]);
     await c.query("update public.fipa_ranking_claim_invites set state='cancelled' where source_key=$1 and state='pending'",[row.source_key]);
    }
    const result=(await c.query('update public.fipa_ranking_requests set state=$1,review_note=$2,reviewed_by=$3,reviewed_at=now() where id=$4 returning *',[decision,note,actor.id,id])).rows[0];
    await c.query('insert into public.fipa_ranking_claim_audit(source_key,action,actor_id,request_id) values($1,$2,$3,$4)',[row.source_key,decision,actor.id,id]);return result;
   });
  },
  links:async()=> (await pool.query('select source_key,user_id from public.fipa_ranking_links')).rows,
  operator:async id=>(await pool.query('select 1 from public.fipa_ranking_operators where user_id=$1 and enabled=true',[id])).rowCount>0,
  invitations:async()=> (await pool.query("select source_key,state,expires_at from public.fipa_ranking_claim_invites where state='pending'")).rows,
  async prepare(player,actor,body){const {email,note}=validateInvitation(body);const token=crypto.randomBytes(32).toString('base64url');
   const invitation=await tx(async c=>{
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa:'+player.source_key]);
    if((await c.query('select 1 from public.fipa_ranking_links where source_key=$1',[player.source_key])).rowCount)throw claimError('Este perfil ya está vinculado.',409);
    await c.query("update public.fipa_ranking_claim_invites set state='cancelled' where source_key=$1 and state='pending'",[player.source_key]);
    const inv=(await c.query('insert into public.fipa_ranking_claim_invites(source_key,token_hash,email,player_name,verification_note,created_by,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval \'14 days\') returning id,expires_at',[player.source_key,tokenHash(token),email,player.nombre_completo,note,actor.id])).rows[0];
    await c.query("insert into public.fipa_ranking_claim_audit(source_key,action,actor_id,invitation_id) values($1,'prepare',$2,$3)",[player.source_key,actor.id,inv.id]);return inv;
   });return {token,...invitation};
  },
  async validate(token){const hash=validateClaimToken(token);const inv=(await pool.query("select source_key,player_name,expires_at from public.fipa_ranking_claim_invites where token_hash=$1 and state='pending' and expires_at>now()",[hash])).rows[0];if(!inv)throw claimError('La invitación venció, ya fue utilizada o no está disponible.',404);return inv;},
  async accept(token,user){const hash=validateClaimToken(token);return tx(async c=>{
   // Account lock prevents concurrent acceptance of two different official identities.
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa-account:'+user.id]);
   const candidate=(await c.query('select source_key from public.fipa_ranking_claim_invites where token_hash=$1',[hash])).rows[0];
   if(!candidate)throw claimError('La invitación no está disponible.',404);
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fipa:'+candidate.source_key]);
   const inv=(await c.query("select * from public.fipa_ranking_claim_invites where token_hash=$1 and state='pending' and expires_at>now() for update",[hash])).rows[0];if(!inv)throw claimError('La invitación venció, ya fue utilizada o no está disponible.',404);
   assertClaimAccount(inv,user);
   if((await c.query('select 1 from public.fipa_ranking_links where source_key=$1 or user_id=$2',[inv.source_key,user.id])).rowCount)throw claimError('El perfil o la cuenta ya están vinculados. Solicita revisión al coordinador.',409);
   await c.query('insert into public.fipa_ranking_links(source_key,user_id) values($1,$2)',[inv.source_key,user.id]);
   await c.query("update public.fipa_ranking_claim_invites set state='used',used_by=$1,used_at=now() where id=$2",[user.id,inv.id]);
   await c.query("insert into public.fipa_ranking_claim_audit(source_key,action,actor_id,invitation_id) values($1,'accept',$2,$3)",[inv.source_key,user.id,inv.id]);return inv.source_key;
  });}
 };
}
