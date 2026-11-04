import { normalizeEmail, normalizePhone } from './crmContact.js';
import { dedupeKeyFor, normalizeDomain, normalizeProspectName, searchPublicProspects } from './crmProspectSource.js';
import { isPadelOnly, scoreProspect } from './crmProspectScoring.js';
import { campaignSteps, classifyProspectResponse, renderCampaignMessage } from './crmProspectCampaigns.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code, message = code) => Object.assign(new Error(message), {status, code});
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const STATUS = new Set(['investigated','verified','pending_approval','approved','contacted','delivered','responded','interested','negotiation','no_response','rejected','opt_out','bounced','paused','closed','existing']);

function sourceRecord(candidate) {
  const score = scoreProspect(candidate);
  return {
    ...candidate,
    dedupe_key: dedupeKeyFor(candidate),
    score: score.score, grade: score.grade, score_breakdown: score.breakdown,
    is_padel_only: score.excluded, exclusion_reason: score.exclusion_reason,
    data_status: candidate.data_status || {},
    updated_at: new Date().toISOString(),
  };
}

async function settings(db) {
  const {data,error}=await db.from('crm_prospect_settings').select('*').eq('singleton',true).maybeSingle();
  if(error) throw fail(503,'PROSPECT_SETTINGS_UNAVAILABLE','No se pudo leer la configuración.');
  return data || {enabled:true,send_enabled:false,weights:{},daily_limit:25};
}

async function suppressed(db, prospect) {
  const values = [prospect.email, prospect.phone].filter(Boolean);
  if (values.length) {
    const {data,error}=await db.from('crm_prospect_suppressions').select('reason').eq('active',true).or(values.map(v=>v.includes('@')?`email.eq.${v}`:`phone.eq.${v}`).join(',')).limit(1);
    if (!error && data?.length) return data[0].reason;
  }
  if (prospect.domain) {
    const {data}=await db.from('crm_prospect_suppressions').select('reason').eq('active',true).eq('domain',prospect.domain).limit(1);
    if (data?.length) return data[0].reason;
  }
  return null;
}

async function existingContact(db, prospect) {
  const queries=[];
  if(prospect.email) queries.push(db.from('crm_contacts').select('id,nombre,email_normalized,phone_normalized').eq('email_normalized',prospect.email).maybeSingle());
  if(prospect.phone) queries.push(db.from('crm_contacts').select('id,nombre,email_normalized,phone_normalized').eq('phone_normalized',prospect.phone).maybeSingle());
  if(!queries.length) return null;
  const rows=(await Promise.all(queries)).map(r=>r.data).filter(Boolean);
  return rows[0] || null;
}

async function activeConversation(db, contactId) {
  if(!contactId) return null;
  const {data}=await db.from('crm_conversations').select('id,estado,operador').eq('contact_id',contactId).neq('estado','cerrado').limit(1);
  return data?.[0] || null;
}

async function writeProspect(db, candidate, actor) {
  const record=sourceRecord(candidate);
  if(record.is_padel_only) return {skipped:'padel'};
  const reason=await suppressed(db,record);
  if(reason) return {skipped:'suppression',reason};
  const {data:existing}=await db.from('crm_prospects').select('*').eq('dedupe_key',record.dedupe_key).maybeSingle();
  const contact=await existingContact(db,record);
  const active=await activeConversation(db,contact?.id);
  const blocked=active ? `Gestión CRM activa (${active.estado})` : contact ? 'Contacto existente en CRM; requiere revisión' : null;
  const base={...record, crm_contact_id:contact?.id||null, crm_conversation_id:active?.id||null, contact_block_reason:blocked, status:blocked?'existing':(existing?.status||'verified'), assigned_user_id:existing?.assigned_user_id||null, created_by:existing?.created_by||actor, updated_by:actor, last_verified_at:new Date().toISOString()};
  if(existing){
    const patch={...base, status:existing.status, assigned_user_id:existing.assigned_user_id, priority:existing.priority, created_by:existing.created_by};
    const {data,error}=await db.from('crm_prospects').update(patch).eq('id',existing.id).select('*').single();
    if(error) throw fail(503,'PROSPECT_UPSERT_FAILED','No se pudo actualizar el prospecto.');
    return {prospect:data,updated:true,blocked};
  }
  const {data,error}=await db.from('crm_prospects').insert(base).select('*').single();
  if(error?.code==='23505'){
    const {data:again}=await db.from('crm_prospects').select('*').eq('dedupe_key',record.dedupe_key).maybeSingle();
    if(again) return {prospect:again,updated:true,blocked};
  }
  if(error) throw fail(503,'PROSPECT_UPSERT_FAILED','No se pudo guardar el prospecto.');
  return {prospect:data,inserted:true,blocked};
}

function filtersFor(q={}) {
  const filters={country:text(q.country,2)||undefined,state:text(q.state,80)||undefined,city:text(q.city,120)||undefined,region:text(q.region,120)||undefined,sector:text(q.sector,80)||undefined,opportunity_type:text(q.opportunity,80)||undefined,source:text(q.source,80)||undefined,assigned_user_id:q.assigned&&uuid.test(q.assigned)?q.assigned:undefined,status:STATUS.has(q.status)?q.status:undefined};
  return Object.fromEntries(Object.entries(filters).filter(([,value])=>value!==undefined));
}

export function createProspectApi({db,resolveTrustedSuperadmin}) {
  if(!db) throw Error('PROSPECT_DB_REQUIRED');
  async function context(user){
    if(!user?.id||!user?.email) throw fail(401,'UNAUTHENTICATED','Iniciá sesión.');
    const superadmin=(await resolveTrustedSuperadmin(user))===true;
    const {data:role,error}=await db.rpc('crm_commercial_team_role',{p_actor:user.id,p_superadmin:superadmin});
    if(error) throw fail(503,'PROSPECT_UNAVAILABLE','No se pudo comprobar el rol.');
    if(!['manager','advisor'].includes(role)) throw fail(403,'FORBIDDEN','No tenés acceso a prospección.');
    return {actor:user.id,email:user.email,superadmin,role};
  }
  async function enabled(){const s=await settings(db);if(!s.enabled) throw fail(404,'PROSPECT_DISABLED','PADBOL PROSPECT no está habilitado.');return s;}
  return {
    async status(user){const ctx=await context(user);const s=await settings(db);return {enabled:s.enabled===true,sendEnabled:s.send_enabled===true,role:ctx.role,sendApprovalRequired:true};},
    async list(user,query={}){await enabled();await context(user);let builder=db.from('crm_prospects').select('*').order('score',{ascending:false}).limit(Math.max(1,Math.min(200,Number(query.limit)||50)));for(const [key,value] of Object.entries(filtersFor(query)))builder=builder.eq(key,value);if(query.minScore!=null)builder=builder.gte('score',Math.max(0,Math.min(100,Number(query.minScore)||0)));if(query.lastVerified)builder=builder.gte('last_verified_at',new Date(query.lastVerified).toISOString());const bucket=String(query.bucket||'');if(bucket==='new')builder=builder.in('status',['investigated','verified']);if(bucket==='existing')builder=builder.eq('status','existing');if(bucket==='contacted')builder=builder.in('status',['contacted','delivered','responded','interested','negotiation']);if(bucket==='discarded')builder=builder.in('status',['rejected','opt_out','bounced','closed']);const {data,error}=await builder;if(error)throw fail(503,'PROSPECT_UNAVAILABLE','No se pudieron leer los prospectos.');return {prospects:data||[]};},
    async search(user,input={}){const s=await enabled();const ctx=await context(user);const run={actor_id:ctx.actor,source:'openstreetmap_nominatim',country:text(input.country,2)||'US',state:text(input.state,80)||null,city:text(input.city,120)||null,sector:text(input.sector,80)||null,opportunity_type:text(input.opportunity,80)||null,requested_limit:Math.max(1,Math.min(50,Number(input.limit)||50))};const {data:runRow,error:runError}=await db.from('crm_prospect_runs').insert(run).select('*').single();if(runError)throw fail(503,'PROSPECT_RUN_FAILED','No se pudo registrar la búsqueda.');try{const source=await searchPublicProspects({country:run.country,state:run.state,city:run.city,limit:run.requested_limit});let inserted=0,updated=0,excluded=0,duplicates=0;for(const candidate of source.prospects){const result=await writeProspect(db,candidate,ctx.email);if(result.skipped==='padel'){excluded++;continue;}if(result.skipped){excluded++;continue;}if(result.inserted)inserted++;else if(result.updated)updated++;else duplicates++;}const {data:finished}=await db.from('crm_prospect_runs').update({status:'completed',found_count:source.prospects.length,inserted_count:inserted,updated_count:updated,duplicate_count:duplicates,excluded_count:excluded,cost_cents:0,finished_at:new Date().toISOString(),metadata:{attribution:source.attribution,query:source.query}}).eq('id',runRow.id).select('*').single();return {run:finished,prospects:source.prospects.length,inserted,updated,excluded,attribution:source.attribution};}catch(e){await db.from('crm_prospect_runs').update({status:'failed',error:String(e?.message||e),finished_at:new Date().toISOString()}).eq('id',runRow.id);throw e;}},
    async read(user,id){await enabled();await context(user);if(!uuid.test(String(id)))throw fail(404,'PROSPECT_NOT_FOUND','Prospecto no encontrado.');const {data,error}=await db.from('crm_prospects').select('*').eq('id',id).maybeSingle();if(error||!data)throw fail(404,'PROSPECT_NOT_FOUND','Prospecto no encontrado.');const [{data:events},{data:messages}]=await Promise.all([db.from('crm_prospect_events').select('*').eq('prospect_id',id).order('created_at',{ascending:false}).limit(100),db.from('crm_prospect_messages').select('*').eq('prospect_id',id).order('created_at',{ascending:false}).limit(50)]);return {prospect:data,events:events||[],messages:messages||[]};},
    async update(user,id,input={}){await enabled();const ctx=await context(user);if(!uuid.test(String(id)))throw fail(404,'PROSPECT_NOT_FOUND','Prospecto no encontrado.');const {data:current}=await db.from('crm_prospects').select('*').eq('id',id).maybeSingle();if(!current)throw fail(404,'PROSPECT_NOT_FOUND','Prospecto no encontrado.');const patch={updated_by:ctx.email,updated_at:new Date().toISOString()};if(input.status!==undefined){if(!STATUS.has(input.status))throw fail(400,'PROSPECT_INVALID_STATUS','Estado inválido.');patch.status=input.status;}if(input.priority!==undefined){if(!['low','normal','high'].includes(input.priority))throw fail(400,'PROSPECT_INVALID_PRIORITY','Prioridad inválida.');patch.priority=input.priority;}if(input.assignedUserId!==undefined){if(input.assignedUserId&&!uuid.test(input.assignedUserId))throw fail(400,'PROSPECT_INVALID_ASSIGNEE','Responsable inválido.');if(input.assignedUserId){const {data:person}=await db.from('crm_commercial_advisors').select('user_id,active').eq('user_id',input.assignedUserId).maybeSingle();if(!person?.active)throw fail(400,'PROSPECT_INVALID_ASSIGNEE','El responsable no está activo.');if(ctx.role==='advisor'&&input.assignedUserId!==ctx.actor)throw fail(403,'FORBIDDEN','Un advisor solo puede asignarse a sí mismo.');}patch.assigned_user_id=input.assignedUserId||null;}for(const key of ['name','legal_name','trade_name','email','phone','website','address','city','state','region','sector','opportunity_type','activities','contact_name','contact_role','facility_notes']){if(input[key]!==undefined)patch[key]=text(input[key],key==='email'?254:key==='phone'?32:key==='website'?512:key==='activities'||key==='facility_notes'?2000:160);}if(patch.email!==undefined)patch.email=normalizeEmail(patch.email);if(patch.phone!==undefined)patch.phone=normalizePhone(patch.phone);if(patch.website!==undefined){patch.domain=normalizeDomain(patch.website);patch.dedupe_key=dedupeKeyFor({...current,...patch});}const {data,error}=await db.from('crm_prospects').update(patch).eq('id',id).select('*').single();if(error)throw fail(503,'PROSPECT_UPDATE_FAILED','No se pudo actualizar el prospecto.');await db.from('crm_prospect_events').insert({prospect_id:id,event_type:'updated',detail:{by:ctx.email},actor_id:ctx.actor});return {prospect:data};},
    async dashboard(user){await enabled();await context(user);const [{data:prospects},{data:runs},{data:campaigns},{data:messages},{data:suppressions}]=await Promise.all([db.from('crm_prospects').select('status,score,country,sector,opportunity_type,assigned_user_id,created_at'),db.from('crm_prospect_runs').select('*').order('started_at',{ascending:false}).limit(20),db.from('crm_prospect_campaigns').select('*'),db.from('crm_prospect_messages').select('status'),db.from('crm_prospect_suppressions').select('id').eq('active',true)]);const rows=prospects||[];const count=(status)=>rows.filter(r=>r.status===status).length;const by=(key)=>Object.entries(rows.reduce((m,r)=>{const v=r[key]||'Sin dato';m[v]=(m[v]||0)+1;return m;},{}));const messageCounts=(messages||[]).reduce((m,r)=>{m[r.status]=(m[r.status]||0)+1;return m;},{});return {totals:{prospects:rows.length,verified:count('verified'),new:count('investigated')+count('verified'),existing:count('existing'),contacted:count('contacted')+count('delivered'),responded:count('responded'),interested:count('interested'),negotiations:count('negotiation'),optOuts:count('opt_out'),bounces:count('bounced'),suppressions:(suppressions||[]).length},byCountry:by('country'),bySector:by('sector'),byOpportunity:by('opportunity_type'),runs:runs||[],campaigns:campaigns||[],messages:messageCounts,sourceCostCents:(runs||[]).reduce((s,r)=>s+(r.cost_cents||0),0)};},
    async campaigns(user){await enabled();await context(user);const {data}=await db.from('crm_prospect_campaigns').select('*,crm_prospect_campaign_steps(*)').order('created_at',{ascending:false});return {campaigns:data||[]};},
    async createCampaign(user,input={}){await enabled();const ctx=await context(user);const name=text(input.name,160);if(!name)throw fail(400,'PROSPECT_CAMPAIGN_INVALID','Poné un nombre a la campaña.');const language=input.language==='es'?'es':'en';const steps=campaignSteps({opportunityType:input.opportunityType,language,subject:input.subject,body:input.body});const {data,error}=await db.from('crm_prospect_campaigns').insert({name,opportunity_type:text(input.opportunityType,80)||'venue_sale',country:text(input.country,2)||'US',language,daily_limit:Math.max(1,Math.min(200,Number(input.dailyLimit)||25)),sender_identity:text(input.senderIdentity,320)||null,status:'draft',created_by:ctx.email}).select('*').single();if(error)throw fail(503,'PROSPECT_CAMPAIGN_FAILED','No se pudo crear la campaña.');const rows=steps.map(step=>({campaign_id:data.id,day:step.day,subject:step.subject,body:step.body}));const {error:stepError}=await db.from('crm_prospect_campaign_steps').insert(rows);if(stepError)throw fail(503,'PROSPECT_CAMPAIGN_FAILED','No se pudieron guardar los pasos.');return {campaign:{...data,steps:rows}};},
    async updateCampaign(user,id,input={}){
      await enabled();const ctx=await context(user);if(ctx.role!=='manager')throw fail(403,'FORBIDDEN','Solo un manager puede aprobar o pausar campañas.');
      if(!uuid.test(String(id)))throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const next=String(input.status||'');
      if(!['approved','paused','active','stopped'].includes(next))throw fail(400,'PROSPECT_CAMPAIGN_INVALID','Estado de campaña inválido.');
      if(next==='active')throw fail(409,'PROSPECT_SEND_DISABLED','El envío real no está habilitado; la campaña permanece aprobada para simulación.');
      const patch={status:next,updated_at:new Date().toISOString()};
      if(next==='approved'){patch.approved_by=ctx.actor;patch.approved_at=new Date().toISOString();}
      const {data,error}=await db.from('crm_prospect_campaigns').update(patch).eq('id',id).select('*').single();
      if(error)throw fail(503,'PROSPECT_CAMPAIGN_FAILED','No se pudo actualizar la campaña.');
      await db.from('crm_prospect_events').insert({campaign_id:id,event_type:`campaign_${next}`,detail:{by:ctx.email},actor_id:ctx.actor});
      return {campaign:data,note:next==='approved'?'Aprobada para simulación; el envío real sigue deshabilitado.':'Campaña actualizada.'};
    },
    async campaignMessages(user,id){
      await enabled();await context(user);
      if(!uuid.test(String(id)))throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const {data:campaign}=await db.from('crm_prospect_campaigns').select('*').eq('id',id).maybeSingle();
      if(!campaign)throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const {data:messages,error}=await db.from('crm_prospect_messages').select('*').eq('campaign_id',id).order('step_day').order('created_at');
      if(error)throw fail(503,'PROSPECT_MESSAGES_UNAVAILABLE','No se pudieron leer los mensajes simulados.');
      const ids=[...new Set((messages||[]).map(m=>m.prospect_id))];
      const {data:prospects}=ids.length?await db.from('crm_prospects').select('id,name,email,city,state,country,status').in('id',ids):{data:[]};
      const byId=new Map((prospects||[]).map(p=>[p.id,p]));
      const rows=(messages||[]).map(m=>({...m,prospect:byId.get(m.prospect_id)||null}));
      const counts=rows.reduce((acc,row)=>{const k=row.status||'unknown';acc[k]=(acc[k]||0)+1;return acc;},{});
      return {campaign,messages:rows,counts,total:rows.length};
    },
    async simulate(user,id){
      await enabled();const ctx=await context(user);
      if(!uuid.test(String(id)))throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const {data:campaign}=await db.from('crm_prospect_campaigns').select('*').eq('id',id).maybeSingle();
      if(!campaign)throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const {data:steps,error:stepError}=await db.from('crm_prospect_campaign_steps').select('*').eq('campaign_id',id).order('day');
      if(stepError)throw fail(503,'PROSPECT_CAMPAIGN_STEPS_UNAVAILABLE','No se pudieron leer los pasos de la campaña.');
      if(!(steps||[]).length)throw fail(409,'PROSPECT_CAMPAIGN_WITHOUT_STEPS','La campaña no tiene pasos de mensaje.');
      const {data:prospects,error:prospectError}=await db.from('crm_prospects').select('*').eq('country',campaign.country).in('status',['investigated','verified','approved']).gte('score',60).order('score',{ascending:false}).limit(campaign.daily_limit);
      if(prospectError)throw fail(503,'PROSPECT_CANDIDATES_UNAVAILABLE','No se pudieron leer los prospectos candidatos.');
      let created=0,blocked=0,noEmail=0,existing=0,failed=0;
      const results=[];
      for(const prospect of prospects||[]){
        const result={prospectId:prospect.id,name:prospect.name||prospect.legal_name||'Prospecto sin nombre',email:prospect.email||null,city:prospect.city||null,state:prospect.state||null,status:prospect.status,score:prospect.score,outcome:'excluded',reason:null,messages:[]};
        if(!prospect.email){noEmail++;result.outcome='excluded';result.reason='Sin correo electrónico verificado';results.push(result);continue;}
        if(prospect.contact_block_reason||['existing','opt_out','bounced','rejected'].includes(prospect.status)){blocked++;result.outcome='excluded';result.reason=prospect.contact_block_reason||`Estado ${prospect.status}`;results.push(result);continue;}
        let prospectCreated=0,prospectExisting=0,prospectFailed=0;
        for(const step of steps||[]){
          const message=renderCampaignMessage(step,prospect,campaign.language);
          const key=`${campaign.id}:${prospect.id}:${step.day}`;
          const {data:found}=await db.from('crm_prospect_messages').select('*').eq('idempotency_key',key).maybeSingle();
          if(found){existing++;prospectExisting++;result.messages.push({...found,existing:true});continue;}
          const scheduledAt=new Date(Date.now()+step.day*86400000).toISOString();
          const {data:inserted,error}=await db.from('crm_prospect_messages').insert({campaign_id:campaign.id,prospect_id:prospect.id,step_day:step.day,recipient:prospect.email,subject:message.subject,body:message.body,status:'simulated',idempotency_key:key,scheduled_at:scheduledAt}).select('*').single();
          if(error?.code==='23505'){
            const {data:again}=await db.from('crm_prospect_messages').select('*').eq('idempotency_key',key).maybeSingle();
            existing++;prospectExisting++;if(again)result.messages.push({...again,existing:true});continue;
          }
          if(error){failed++;prospectFailed++;result.messages.push({step_day:step.day,recipient:prospect.email,subject:message.subject,body:message.body,status:'failed',error:error.message||'No se pudo preparar'});continue;}
          created++;prospectCreated++;result.messages.push(inserted||{step_day:step.day,recipient:prospect.email,subject:message.subject,body:message.body,status:'simulated',scheduled_at:scheduledAt});
        }
        result.outcome=prospectCreated?'prepared':(prospectFailed&&!prospectExisting?'failed':'already_prepared');
        result.reason=prospectCreated?'Mensajes preparados en simulación':prospectFailed?'Error al preparar mensajes':'Mensajes ya preparados; no se duplicaron';
        result.created=prospectCreated;result.existing=prospectExisting;result.failed=prospectFailed;
        results.push(result);
        if(prospectCreated){
          await db.from('crm_prospect_events').insert({prospect_id:prospect.id,campaign_id:campaign.id,event_type:'campaign_simulated',detail:{step_days:(steps||[]).map(s=>s.day),created:prospectCreated,existing:prospectExisting,simulation:true},actor_id:ctx.actor});
        }
      }
      const prepared=results.filter(r=>r.outcome==='prepared').length;
      const alreadyPrepared=results.filter(r=>r.outcome==='already_prepared').length;
      const failedProspects=results.filter(r=>r.outcome==='failed').length;
      const excluded=noEmail+blocked+failedProspects;
      return {
        simulation:true,sent:0,
        campaign:{id:campaign.id,name:campaign.name,status:campaign.status,language:campaign.language,dailyLimit:campaign.daily_limit},
        candidates:(prospects||[]).length,evaluated:(prospects||[]).length,
        created,blocked,noEmail,existing,failed:failedProspects,
        prepared,alreadyPrepared,excluded,
        results,
        message:created?`Simulación completada: ${created} correo(s) preparado(s), ${existing} ya existente(s), ${excluded} excluido(s). No se envió ningún correo.`:'No se prepararon mensajes nuevos. Revisá los motivos por prospecto; no se envió ningún correo.',
      };
    },
    async simulateFollowup(user,id,input={}){
      await enabled();const ctx=await context(user);
      if(!uuid.test(String(id)))throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const {data:campaign}=await db.from('crm_prospect_campaigns').select('*').eq('id',id).maybeSingle();
      if(!campaign)throw fail(404,'PROSPECT_CAMPAIGN_NOT_FOUND','Campaña no encontrada.');
      const asOf=Math.max(0,Math.min(14,Number(input.day)||14));
      const {data:messages}=await db.from('crm_prospect_messages').select('*').eq('campaign_id',id).order('step_day');
      const {data:prospects}=await db.from('crm_prospects').select('*').in('id',[...new Set((messages||[]).map(m=>m.prospect_id))]);
      const byId=new Map((prospects||[]).map(p=>[p.id,p]));
      const planned=[];const skipped=[];
      for(const message of messages||[]){
        if(![0,7,14].includes(Number(message.step_day))||Number(message.step_day)>asOf)continue;
        const prospect=byId.get(message.prospect_id);
        if(!prospect)continue;
        if(prospect.contact_block_reason||['responded','interested','negotiation','rejected','opt_out','bounced','closed','paused','existing'].includes(prospect.status)){
          skipped.push({prospect_id:message.prospect_id,step_day:message.step_day,reason:prospect.contact_block_reason||prospect.status});
          continue;
        }
        if(Number(message.step_day)===0)continue;
        if(message.status!=='simulated')continue;
        const {data:existing}=await db.from('crm_prospect_events').select('id,detail').eq('prospect_id',message.prospect_id).eq('event_type','followup_simulated');
        const already=(existing||[]).some(e=>Number(e.detail?.day)===asOf&&Number(e.detail?.step_day)===Number(message.step_day));
        if(already)continue;
        planned.push({prospect_id:message.prospect_id,step_day:message.step_day,recipient:message.recipient});
        await db.from('crm_prospect_events').insert({prospect_id:message.prospect_id,campaign_id:campaign.id,event_type:'followup_simulated',detail:{day:asOf,step_day:message.step_day,simulation:true,recipient:message.recipient},actor_id:ctx.actor});
      }
      return {simulation:true,sent:0,day:asOf,planned:planned.length,skipped:skipped.length,details:{planned,skipped},message:'Simulación de seguimiento: no se envió ningún correo.'};
    },
    async response(user,id,input={}){await enabled();const ctx=await context(user);if(!uuid.test(String(id)))throw fail(404,'PROSPECT_NOT_FOUND','Prospecto no encontrado.');const classification=classifyProspectResponse(input.text||'');const status={opt_out:'opt_out',bounce:'bounced',rejected:'rejected',interest:'interested',information_request:'responded',negotiation:'interested',automatic_reply:'paused',ambiguous:'responded'}[classification]||'responded';const {data:prospect}=await db.from('crm_prospects').update({status,updated_at:new Date().toISOString()}).eq('id',id).select('*').single();await db.from('crm_prospect_messages').update({status:'cancelled'}).eq('prospect_id',id).in('status',['simulated','queued']);await db.from('crm_prospect_events').insert({prospect_id:id,event_type:'response',detail:{classification,text:text(input.text,2000)},actor_id:ctx.actor});if(['opt_out','bounce'].includes(classification)&&prospect?.email)await db.from('crm_prospect_suppressions').insert({email:prospect.email,reason:classification,source:'response',created_by:ctx.email});return {classification,status,requiresReview:['ambiguous','automatic_reply'].includes(classification)};},
    async suppressions(user){await enabled();await context(user);const {data}=await db.from('crm_prospect_suppressions').select('*').eq('active',true).order('created_at',{ascending:false}).limit(200);return {suppressions:data||[]};},
    async addSuppression(user,input={}){await enabled();const ctx=await context(user);const email=normalizeEmail(input.email||'');const phone=normalizePhone(input.phone||'');const domain=normalizeDomain(input.domain||'');const reason=text(input.reason,160);if(!reason||(!email&&!phone&&!domain))throw fail(400,'PROSPECT_SUPPRESSION_INVALID','Indicá identidad y motivo.');const {data,error}=await db.from('crm_prospect_suppressions').insert({email:email||null,phone:phone||null,domain:domain||null,reason,source:'manual',created_by:ctx.email}).select('*').single();if(error?.code==='23505')throw fail(409,'PROSPECT_SUPPRESSION_EXISTS','Ya existe una baja global para esa identidad.');if(error)throw fail(503,'PROSPECT_SUPPRESSION_FAILED','No se pudo guardar la baja.');return {suppression:data};},
  };
}
