import {createHash,randomUUID} from 'node:crypto';
import {buildSedeReleaseInsert} from './sedeReleaseContract.js';
import {buildAdminRoleGeography} from './adminTerritorialScope.js';
import {mapPendingRowToSedeInsert} from './sedePendingMapping.js';

const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const clean=value=>String(value??'').trim();
const norm=value=>clean(value).toLowerCase();
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
const roleFields=['role','alcance','sede_id','pais','provincia','ciudad','nombre','torneos_oficiales_habilitados'];
const snapshot=r=>r?Object.fromEntries(['user_id','email',...roleFields,'organizacion_id'].filter(k=>k in r).map(k=>[k,r[k]])):null;

function roleFor(p,sedeId){
  const type=norm(p.tipo_licencia)||'club_afiliado';
  const geo={pais:clean(p.pais_representa||p.licenciatario_pais||p.pais),provincia:clean(p.provincia_representa||p.provincia),ciudad:clean(p.ciudad_representa||p.ciudad)};
  const scope={master_ciudad:'ciudad',master_provincia:'provincia',master_pais:'pais'}[type];
  const a=scope?{role:'admin_nacional',alcance:scope,sede_id:null,...buildAdminRoleGeography(scope,geo)}:
    {role:'admin_club',alcance:'sede',sede_id:sedeId,pais:clean(p.licenciatario_pais||p.pais)||null,provincia:null,ciudad:null};
  return {...a,email:norm(p.licenciatario_email),nombre:clean(p.licenciatario_nombre)||null,torneos_oficiales_habilitados:!!scope};
}

function sedeFor(p){ return buildSedeReleaseInsert(mapPendingRowToSedeInsert(p)); }

async function insertTyped(client,table,payload){
  // Los nombres solo provienen de listas locales (nunca de req.body). Los tipos
  // reales se resuelven con el composite legacy; las columnas omitidas mantienen defaults.
  const keys=Object.keys(payload);
  if(!['sedes','user_roles'].includes(table)||keys.some(k=>!/^\w+$/.test(k)))throw fail('INVALID_INTERNAL_INSERT',500);
  const cols=keys.map(k=>'"'+k+'"').join(',');
  return (await client.query(`INSERT INTO public.${table} (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::public.${table},$1::jsonb) RETURNING *`,[JSON.stringify(payload)])).rows[0];
}
function compatible(existing,expected){
  return ['role','alcance','sede_id','pais','provincia','ciudad'].every(k=>
    k==='sede_id'?String(existing[k]??'')===String(expected[k]??''):norm(existing[k])===norm(expected[k]));
}
async function assertActor(client,actorId){
  if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(actorId||''))throw fail('SUPERADMIN_REQUIRED',403);
  const r=await client.query("SELECT 1 FROM public.user_roles WHERE user_id=$1::uuid AND role='super_admin' LIMIT 1",[actorId]);
  if(!r.rows.length)throw fail('SUPERADMIN_REQUIRED',403);
}
async function transaction(pool,fn){
  if(!pool?.connect)throw fail('APPROVAL_DATABASE_UNAVAILABLE',503);
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");await client.query("SET LOCAL statement_timeout='15s'");const result=await fn(client);await client.query('COMMIT');return result;}
  catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
}

export function createSedeApprovalRecovery({pool}){
  async function approve({actorId,requestId,recoverySedeId=null}){
    if(!positive(requestId)||recoverySedeId!==null&&!positive(recoverySedeId))throw fail('INVALID_APPROVAL_ID',400);
    requestId=Number(requestId);if(recoverySedeId!==null)recoverySedeId=Number(recoverySedeId);
    return transaction(pool,async client=>{
      await assertActor(client,actorId);
      const request=(await client.query('SELECT * FROM public.sedes_pendientes WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
      if(!request)throw fail('REQUEST_NOT_FOUND',404);
      const operation=(await client.query('SELECT * FROM public.sede_approval_operations WHERE request_id=$1',[requestId])).rows[0];
      if(operation){
        if(recoverySedeId!==null&&String(recoverySedeId)!==String(operation.sede_id))throw fail('RECOVERY_LINK_CONFLICT');
        const pending=(await client.query("SELECT EXISTS(SELECT 1 FROM public.sede_approval_outbox WHERE request_id=$1 AND state NOT IN ('succeeded','skipped')) AS pending",[requestId])).rows[0].pending;
        return {ok:true,sede_id:operation.sede_id,replayed:true,notifications_pending:pending};
      }
      // Un estado legacy aprobado sin relación no demuestra qué sede se creó.
      if(request.estado!=='pendiente'&&!(recoverySedeId!==null&&request.estado==='aprobada'))throw fail('REQUEST_REQUIRES_MANUAL_RECONCILIATION');
      const sedePayload=sedeFor(request),email=norm(request.licenciatario_email);
      if(!email)throw fail('LICENSEE_EMAIL_REQUIRED',400);
      // Evita que dos solicitudes distintas creen dos veces el mismo club.
      const venueKey=[sedePayload.nombre,sedePayload.pais,sedePayload.ciudad].map(norm).join('|');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dg09:venue:${venueKey}`]);
      // No modificar el esquema ni asumir unicidad normalizada de email legacy.
      // El lock de tabla también protege frente a escrituras legacy que no usan
      // nuestro advisory lock; el volumen de aprobación es bajo y el tx es corto.
      await client.query('LOCK TABLE public.user_roles IN SHARE ROW EXCLUSIVE MODE');
      const roles=(await client.query('SELECT * FROM public.user_roles WHERE lower(btrim(email))=$1 FOR UPDATE',[email])).rows;
      if(roles.length>1)throw fail('AMBIGUOUS_EXISTING_ROLE');
      const roleBefore=roles[0]||null;
      let organization=null;
      if(request.organizacion_id){
        organization=(await client.query('SELECT * FROM public.organizaciones WHERE id=$1 FOR UPDATE',[request.organizacion_id])).rows[0];
        if(!organization||organization.estado!=='activa')throw fail('ORGANIZATION_NOT_ACTIVE');
      }
      const preserveChain=!!(organization&&email===norm(request.created_by));
      if(preserveChain&&(!roleBefore||roleBefore.role!=='admin_cadena'||String(roleBefore.organizacion_id)!==String(request.organizacion_id)))throw fail('CHAIN_ROLE_MISMATCH');
      // Validar geografía y conflicto de rol antes de crear la sede.
      const provisional=roleFor(request,recoverySedeId??-1);
      if(!preserveChain&&roleBefore&&!compatible(roleBefore,provisional))throw fail('EXISTING_ROLE_CONFLICT');
      const matches=(await client.query('SELECT id FROM public.sedes WHERE lower(btrim(nombre))=$1 AND lower(btrim(pais))=$2 AND lower(btrim(ciudad))=$3 FOR UPDATE',[norm(sedePayload.nombre),norm(sedePayload.pais),norm(sedePayload.ciudad)])).rows;
      let sede;
      if(recoverySedeId!==null){
        // Recuperación explícita, solo superadmin: nunca adivinar una sede por nombre.
        sede=(await client.query('SELECT * FROM public.sedes WHERE id=$1 FOR UPDATE',[recoverySedeId])).rows[0];
        if(!sede||!matches.some(x=>String(x.id)===String(recoverySedeId)))throw fail('RECOVERY_VENUE_IDENTITY_MISMATCH');
        const linked=(await client.query('SELECT request_id FROM public.sede_approval_operations WHERE sede_id=$1',[recoverySedeId])).rows;
        if(linked.length)throw fail('RECOVERY_VENUE_ALREADY_LINKED');
      }else{
        if(matches.length)throw fail('POSSIBLE_LEGACY_PARTIAL_APPROVAL');
        sede=await insertTyped(client,'sedes',sedePayload);
      }
      if(organization){
        const links=(await client.query('SELECT organizacion_id FROM public.organizacion_sedes WHERE sede_id=$1 FOR UPDATE',[sede.id])).rows;
        if(links.some(x=>String(x.organizacion_id)!==String(organization.id)))throw fail('VENUE_ORGANIZATION_CONFLICT');
        if(!links.length){
          // Capacity is consumed by a new link, including recovery. Use the
          // stored venue's courts, never the editable request's smaller count.
          const courts=Number(sede.cantidad_canchas);
          if(!Number.isSafeInteger(courts)||courts<1)throw fail('VENUE_COURT_CAPACITY_REQUIRED');
          const usage=(await client.query('SELECT count(*)::int AS sedes,COALESCE(sum(s.cantidad_canchas),0)::int AS courts FROM public.organizacion_sedes os JOIN public.sedes s ON s.id=os.sede_id WHERE os.organizacion_id=$1',[organization.id])).rows[0];
          if(Number(usage.sedes)+1>Number(organization.limite_sedes)||Number(usage.courts)+courts>Number(organization.limite_canchas_total))throw fail('ORGANIZATION_LIMIT_EXCEEDED');
          await client.query('INSERT INTO public.organizacion_sedes(organizacion_id,sede_id) VALUES($1,$2)',[organization.id,sede.id]);
        }
      }
      const desired=roleFor(request,sede.id);
      let roleAfter=roleBefore;
      if(!preserveChain){
        if(roleBefore&&!compatible(roleBefore,desired))throw fail('EXISTING_ROLE_CONFLICT');
        if(!roleBefore)roleAfter=await insertTyped(client,'user_roles',desired);
        // Un rol compatible existente se conserva completo; nunca sobrescribir
        // nombre, user_id, permisos o datos ajenos por un alta de sede.
      }
      const updated=await client.query("UPDATE public.sedes_pendientes SET estado='aprobada' WHERE id=$1 RETURNING id",[requestId]);
      if(updated.rows.length!==1)throw fail('APPROVAL_STATE_NOT_PERSISTED',503);
      const fingerprint=createHash('sha256').update(JSON.stringify({requestId:String(requestId),venueKey,email,tipo:request.tipo_licencia||'club_afiliado'})).digest('hex');
      await client.query('INSERT INTO public.sede_approval_operations(request_id,sede_id,actor_user_id,recovered_existing,role_preserved,role_before,role_after,request_fingerprint,delivery_context) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb)',[requestId,sede.id,actorId,recoverySedeId!==null,!!roleBefore,JSON.stringify(snapshot(roleBefore)),JSON.stringify(snapshot(roleAfter)),fingerprint,JSON.stringify(Object.fromEntries(['nombre','pais','ciudad','licenciatario_email','licenciatario_nombre','licenciatario_telefono','whatsapp','created_by'].map(k=>[k,clean(request[k])||null])))]);
      const kinds=[['auth_user',null],['welcome_email','auth_user'],['registration_event','auth_user'],['whatsapp_creator',null],['whatsapp_license',null]];
      for(const [kind,dependency] of kinds)await client.query('INSERT INTO public.sede_approval_outbox(request_id,kind,prerequisite_kind) VALUES($1,$2,$3)',[requestId,kind,dependency]);
      return {ok:true,sede_id:sede.id,replayed:false,recovered:recoverySedeId!==null,notifications_pending:true};
    });
  }
  async function status({actorId,requestId}){
    if(!positive(requestId))throw fail('INVALID_APPROVAL_ID',400);
    return transaction(pool,async c=>{await assertActor(c,actorId);const operation=(await c.query('SELECT request_id,sede_id,completed_at,recovered_existing,role_preserved,delivery_context->>\'licenciatario_email\' AS approved_recipient_email FROM public.sede_approval_operations WHERE request_id=$1',[requestId])).rows[0];if(!operation)throw fail('APPROVAL_NOT_FOUND',404);const jobs=(await c.query('SELECT kind,state,attempts,last_error_code,provider_reference FROM public.sede_approval_outbox WHERE request_id=$1 ORDER BY id',[requestId])).rows;return {operation,jobs};});
  }
  async function reconcileDelivery({actorId,requestId,kind,outcome,evidenceReference,authUserId,authOrigin}){
    if(!positive(requestId)||!['auth_user','welcome_email','registration_event','whatsapp_creator','whatsapp_license'].includes(kind)||!['confirmed_delivered','confirmed_not_sent'].includes(outcome)||!clean(evidenceReference)||clean(evidenceReference).length>200)throw fail('INVALID_DELIVERY_RECONCILIATION',400);
    return transaction(pool,async c=>{
      await assertActor(c,actorId);
      const job=(await c.query('SELECT * FROM public.sede_approval_outbox WHERE request_id=$1 AND kind=$2 FOR UPDATE',[requestId,kind])).rows[0];
      if(!job)throw fail('DELIVERY_NOT_FOUND',404);
      if(!['uncertain','blocked'].includes(job.state))throw fail('DELIVERY_NOT_RECONCILABLE');
      const state=outcome==='confirmed_delivered'?'succeeded':'pending';
      let providerReference=state==='succeeded'?clean(evidenceReference):null;
      if(kind==='auth_user'&&state==='succeeded'){
        if(typeof authUserId!=='string'||!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(authUserId)||!['created','existing'].includes(authOrigin))
          throw fail('AUTH_RECONCILIATION_IDENTITY_REQUIRED',400);
        // Identity/provenance stays in the provider receipt. The operator's
        // evidence is recorded independently in the immutable review journal.
        providerReference=authOrigin==='created'?`auth:${authUserId.toLowerCase()}`:`auth:existing:${authUserId.toLowerCase()}`;
      }
      await c.query('INSERT INTO public.sede_approval_delivery_reviews(request_id,kind,actor_user_id,outcome,previous_state,evidence_reference) VALUES($1,$2,$3,$4,$5,$6)',[requestId,kind,actorId,outcome,job.state,clean(evidenceReference)]);
      await c.query('UPDATE public.sede_approval_outbox SET state=$3,provider_reference=$4,last_error_code=$5,attempts=0,next_attempt_at=now(),updated_at=now() WHERE request_id=$1 AND kind=$2',[requestId,kind,state,providerReference,outcome==='confirmed_delivered'?'OPERATOR_CONFIRMED_DELIVERY':'OPERATOR_CONFIRMED_NOT_SENT']);
      return {ok:true,kind,state};
    });
  }
  return {approve,status,reconcileDelivery};
}

// Worker desacoplado del alta. No contiene credenciales ni realiza envíos por sí
// mismo. Un adaptador QA/proveedor debe devolver referencia o rechazo previo
// verificable; cualquier resultado ambiguo se congela para reconciliación.
export function createSedeApprovalOutboxWorker({pool,deliver,leaseSeconds=120}){
  if(typeof deliver!=='function'||!Number.isSafeInteger(leaseSeconds)||leaseSeconds<10)throw fail('INVALID_WORKER_CONFIGURATION',500);
  async function runOne({requestId=null}={}){
    if(requestId!==null&&!positive(requestId))throw fail('INVALID_APPROVAL_ID',400);
    const job=await transaction(pool,async c=>{
      await c.query("UPDATE public.sede_approval_outbox SET state=CASE WHEN kind='auth_user' AND attempts<5 THEN 'retryable' ELSE 'uncertain' END,lease_token=NULL,lease_until=NULL,last_error_code='DELIVERY_ACK_UNKNOWN',updated_at=now() WHERE state='running' AND lease_until<now()");
      const row=(await c.query("SELECT o.* FROM public.sede_approval_outbox o WHERE o.state IN ('pending','retryable') AND o.attempts<5 AND o.next_attempt_at<=now() AND (o.prerequisite_kind IS NULL OR EXISTS(SELECT 1 FROM public.sede_approval_outbox p WHERE p.request_id=o.request_id AND p.kind=o.prerequisite_kind AND p.state='succeeded'))"+(requestId!==null?' AND o.request_id=$1':'')+" ORDER BY o.id FOR UPDATE SKIP LOCKED LIMIT 1",requestId!==null?[requestId]:[])).rows[0];
      if(!row)return null;
      const token=randomUUID();
      await c.query("UPDATE public.sede_approval_outbox SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+($3::int*interval '1 second'),updated_at=now() WHERE id=$1",[row.id,token,leaseSeconds]);
      return {...row,token,idempotencyKey:`sede-approval:${row.request_id}:${row.kind}`};
    });
    if(!job)return {processed:false};
    try{
      const result=await deliver({requestId:job.request_id,kind:job.kind,idempotencyKey:job.idempotencyKey});
      // Un adaptador que no confirma resultado no debe marcar entrega como hecha.
      if(result?.accepted!==true&&result?.skipped!==true)throw fail('DELIVERY_NOT_ACKNOWLEDGED',503);
      const ref=clean(result.reference).slice(0,200)||null;
      const finalState=result?.skipped===true?'skipped':'succeeded';
      const r=await pool.query("UPDATE public.sede_approval_outbox SET state=$4,provider_reference=$3,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",[job.id,job.token,ref,finalState]);
      if(r.rows.length!==1)return {processed:true,state:'uncertain',reason:'LEASE_CHANGED'};
      return {processed:true,state:finalState,kind:job.kind};
    }catch(error){
      const retry=error?.safeToRetry===true&&Number(job.attempts)+1<5;
      const state=error?.blocked===true?'blocked':retry?'retryable':error?.safeToRetry===true?'blocked':'uncertain';
      // No almacenar mensajes del proveedor, datos personales, tokens o URLs.
      await pool.query("UPDATE public.sede_approval_outbox SET state=$3,lease_token=NULL,lease_until=NULL,last_error_code=$4,next_attempt_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running'",[job.id,job.token,state,retry?'DELIVERY_REJECTED_BEFORE_ACCEPTANCE':'DELIVERY_ACK_UNKNOWN']);
      return {processed:true,state,kind:job.kind};
    }
  }
  return {runOne};
}
