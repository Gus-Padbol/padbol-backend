import {createHash} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validCalendarDate=value=>{const y=Number(value.slice(0,4)),m=Number(value.slice(5,7)),d=Number(value.slice(8,10));const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d;};
const utcDate=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const fail=(status,code)=>Object.assign(Error(code),{status,code});
// Not registered by default. superadmin is determined from the server-side role lookup.
export function createCommercialTeamApi({db,sendClaimed,sendFormClaimed=null,retrieveMemberMedia=null,resolveTrustedSuperadmin}) {
 if(!db?.rpc||typeof sendClaimed!=='function'||typeof resolveTrustedSuperadmin!=='function')throw Error('COMMERCIAL_TEAM_CONFIG_INVALID');
 const rpc=async(name,args)=>{const r=await db.rpc(name,args);if(r.error){const msg=String(r.error.message||'');if(msg.includes('assignment conflict'))throw fail(409,'ASSIGNMENT_CONFLICT');if(msg.includes('pending send')||msg.includes('advisor has active cases')||msg.includes('call summary required')||msg.includes('crm_commercial_one_pending_call'))throw fail(409,'ACTION_BLOCKED');if(msg.includes('case unavailable')||msg.includes('advisor unavailable')||msg.includes('call unavailable'))throw fail(404,'NOT_AVAILABLE');if(msg.includes('not authorized'))throw fail(403,'FORBIDDEN');throw fail(503,'UNAVAILABLE');}return r.data;};
 const context=async user=>{if(!uuid.test(String(user?.id||''))||!user?.email)throw fail(401,'UNAUTHENTICATED');const admin=(await resolveTrustedSuperadmin(user))===true;const args={p_actor:user.id,p_superadmin:admin};const role=await rpc('crm_commercial_team_role',args);if(!['manager','advisor'].includes(role))throw fail(403,'FORBIDDEN');return {...args,role};};
 const checkId=id=>{if(!uuid.test(String(id||'')))throw fail(404,'NOT_AVAILABLE');return id;};
 const management=ctx=>{if(ctx.role!=='manager')throw fail(403,'FORBIDDEN');};
 const readScoped=async(ctx,type,id)=>{
  let v=await rpc(type==='form'?'crm_commercial_team_form_read':'crm_commercial_team_case_read',{...ctxArgs(ctx),[type==='form'?'p_id':'p_case']:id});
  if(!v)throw fail(404,'NOT_AVAILABLE');
  // Historical media projection omitted progress fields; recover them only from an authorized projection.
  if(type==='whatsapp' && v.progressState===undefined){const list=await rpc('crm_commercial_team_case_list',ctxArgs(ctx));const item=Array.isArray(list)?list.find(c=>c.id===id):null;if(item)v={...v,progressState:item.progressState,nextStep:item.nextStep};}
  const schedule=await rpc('crm_commercial_team_schedule_read',{...ctxArgs(ctx),p_type:type,p_case:id});
  return {...v,nextContactAt:utcDate(schedule?.nextContactAt),reminderHours:schedule?.reminderHours ?? [24,8]};
 };

 return {
  async role(user){const ctx=await context(user);return {role:ctx.role};},
  async list(user){const ctx=await context(user);const [wa,forms,schedules]=await Promise.all([rpc('crm_commercial_team_case_list',ctxArgs(ctx)),rpc('crm_commercial_team_form_list',ctxArgs(ctx)),rpc('crm_commercial_team_schedule_list',ctxArgs(ctx))]);const agenda=new Map((schedules||[]).map(x=>[`${x.channel}:${x.id}`,x]));return {cases:[...(wa||[]).map(x=>({...x,channel:'whatsapp'})),...(forms||[])].map(x=>({...x,conversationId:agenda.get(`${x.channel}:${x.id}`)?.conversationId||(x.channel==='form'?x.id:undefined),nextContactAt:utcDate(agenda.get(`${x.channel}:${x.id}`)?.nextContactAt),reminderHours:agenda.get(`${x.channel}:${x.id}`)?.reminderHours??[24,8]}))};},
  async read(user,type,id){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type))throw fail(404,'NOT_AVAILABLE');return readScoped(ctx,type,id);},
  async resolveConversation(user,id){
   const ctx=await context(user);checkId(id);
   // Resolve a stored relationship, then enforce the same RPC scope as the commercial workspace.
   const conv=await db.from('crm_conversations').select('id,source_channel').eq('id',id).maybeSingle();
   if(conv.error)throw fail(503,'UNAVAILABLE');if(!conv.data)throw fail(404,'NOT_AVAILABLE');
   const whatsapp=conv.data.source_channel==='whatsapp';let caseId=id;
   if(whatsapp){const linked=await db.from('crm_commercial_cases').select('id').eq('conversation_id',id).in('status',['open','suspended']).maybeSingle();if(linked.error)throw fail(503,'UNAVAILABLE');if(!linked.data)throw fail(404,'NOT_AVAILABLE');caseId=linked.data.id;}
   const v=await readScoped(ctx,whatsapp?'whatsapp':'form',caseId);return {...v,channel:whatsapp?'whatsapp':'form'};
  },
  async advisors(user){const ctx=await context(user);management(ctx);return {advisors:await rpc('crm_commercial_team_advisors_list',ctxArgs(ctx))||[]};},
  async addAdvisor(user,email){const ctx=await context(user);management(ctx);if(typeof email!=='string'||email.length>254||!email.includes('@'))throw fail(400,'INVALID_EMAIL');return rpc('crm_commercial_advisor_add',{...ctxArgs(ctx),p_email:email});},
  async disableAdvisor(user,id){const ctx=await context(user);management(ctx);checkId(id);await rpc('crm_commercial_advisor_disable',{...ctxArgs(ctx),p_advisor:id});return {ok:true};},
  async assign(user,type,id,advisor,version){const ctx=await context(user);management(ctx);checkId(id);checkId(advisor);if(!Number.isSafeInteger(version)||version<0||!['form','whatsapp'].includes(type))throw fail(400,'INVALID_ASSIGNMENT');const wa=type==='whatsapp';const result=await rpc(wa?'crm_commercial_case_assign':'crm_commercial_form_assign',{...ctxArgs(ctx),[wa?'p_case':'p_conversation']:id,p_advisor:advisor,p_version:version});return {case:{id:result.id,version:result.assignmentVersion,assignedAdvisor:{id:result.assignedAdvisorId}}};},
  async followupStart(user,type,id,language,consentEvidence,templateKey){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type)||!['es','en'].includes(language)||typeof consentEvidence!=='string'||consentEvidence.trim().length<3||consentEvidence.length>2000||typeof templateKey!=='string'||templateKey.trim().length<3||templateKey.length>120)throw fail(400,'INVALID_FOLLOWUP');return rpc('crm_commercial_followup_start',{...ctxArgs(ctx),p_type:type,p_case:id,p_language:language,p_consent_evidence:consentEvidence.trim(),p_template_key:templateKey.trim()});},
  async followupCancel(user,type,id){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type))throw fail(400,'INVALID_FOLLOWUP');return rpc('crm_commercial_followup_cancel',{...ctxArgs(ctx),p_type:type,p_case:id});},
  async progress(user,type,id,version,state,nextStep,nextContactAt,reminderHours){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type)||!Number.isSafeInteger(version)||version<0||!['nuevo','en_atencion','en_espera','cerrado'].includes(state)||typeof nextStep!=='string'||nextStep.length>2000)throw fail(400,'INVALID_PROGRESS');if(state!=='nuevo'){if(nextStep.trim().length<3)throw fail(400,'NEXT_STEP_REQUIRED');const calls=await rpc('crm_commercial_team_calls_list',{...ctxArgs(ctx),p_type:type,p_case:id});if(!(calls||[]).some(c=>c.status==='completed'))throw fail(409,'CALL_SUMMARY_REQUIRED');}if(nextContactAt===undefined&&state!=='cerrado')return rpc('crm_commercial_team_progress',{...ctxArgs(ctx),p_type:type,p_case:id,p_version:version,p_state:state,p_next:nextStep});if(nextContactAt===undefined)nextContactAt=null;if(reminderHours===undefined)reminderHours=[24,8];if(nextContactAt!==null&&(typeof nextContactAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(nextContactAt)||!Number.isFinite(Date.parse(nextContactAt))||!validCalendarDate(nextContactAt)))throw fail(400,'INVALID_SCHEDULE');if(!Array.isArray(reminderHours)||reminderHours.length<1||reminderHours.length>5||reminderHours.some(h=>!Number.isSafeInteger(h)||h<1||h>720)||new Set(reminderHours).size!==reminderHours.length||(state!=='cerrado'&&nextContactAt!==null&&Date.parse(nextContactAt)<=Date.now()))throw fail(400,'INVALID_SCHEDULE');return rpc('crm_commercial_team_progress_scheduled',{...ctxArgs(ctx),p_type:type,p_case:id,p_version:version,p_state:state,p_next:nextStep,p_next_contact_at:state==='cerrado'?null:nextContactAt,p_reminder_hours:[...reminderHours].sort((a,b)=>b-a)});},
  async activity(user,type,id,body){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type)||typeof body!=='string'||!body.trim()||body.length>2000)throw fail(400,'INVALID_ACTIVITY');return rpc('crm_commercial_team_activity',{...ctxArgs(ctx),p_type:type,p_case:id,p_body:body});},
  async activities(user,type,id){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type))throw fail(400,'INVALID_ACTIVITY');return {activities:await rpc('crm_commercial_team_activity_list',{...ctxArgs(ctx),p_type:type,p_case:id})||[]};},
  async calls(user,type,id){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type))throw fail(400,'INVALID_CHANNEL');return {calls:await rpc('crm_commercial_team_calls_list',{...ctxArgs(ctx),p_type:type,p_case:id})||[]};},
  async openCall(user,type,id){const ctx=await context(user);checkId(id);if(!['form','whatsapp'].includes(type))throw fail(400,'INVALID_CHANNEL');return rpc('crm_commercial_team_call_open',{...ctxArgs(ctx),p_type:type,p_case:id});},
  async completeCall(user,type,id,callId,situation,discussed,distinguishing){const ctx=await context(user);checkId(id);checkId(callId);if(!['form','whatsapp'].includes(type)||[situation,discussed,distinguishing].some(x=>typeof x!=='string'||x.trim().length<3||x.length>2000))throw fail(400,'CALL_SUMMARY_REQUIRED');return rpc('crm_commercial_team_call_complete',{...ctxArgs(ctx),p_type:type,p_case:id,p_call:callId,p_situation:situation,p_discussed:discussed,p_distinguishing:distinguishing});},
  async media(user,caseId,eventId){const ctx=await context(user);checkId(caseId);checkId(eventId);if(typeof retrieveMemberMedia!=='function')throw fail(409,'CHANNEL_UNAVAILABLE');return retrieveMemberMedia({actor:user,superadmin:ctx.p_superadmin,caseId,eventId});},
  async reply(user,type,id,body,requestId){const ctx=await context(user);checkId(id);checkId(requestId);if(!['form','whatsapp'].includes(type))throw fail(400,'INVALID_CHANNEL');if(type==='form'&&typeof sendFormClaimed!=='function')throw fail(409,'CHANNEL_UNAVAILABLE');if(typeof body!=='string'||!body.trim()||body.length>4096)throw fail(400,'INVALID_REPLY');const h=createHash('sha256').update(`${id.toLowerCase()}:${requestId.toLowerCase()}`).digest('hex');const replyId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;const form=type==='form';const claim=await rpc(form?'crm_commercial_team_form_claim_reply':'crm_commercial_team_claim_reply',{...ctxArgs(ctx),[form?'p_case':'p_case_id']:id,p_reply_id:replyId,p_body:body.trim()});if(claim?.blocked)throw fail(409,'REPLY_PENDING');if(!claim?.created)return {status:'already_attempted'};return (form?sendFormClaimed:sendClaimed)({caseId:id,actorId:user.id,replyId,superadmin:ctx.p_superadmin});}
 };
}
function ctxArgs(ctx){return {p_actor:ctx.p_actor,p_superadmin:ctx.p_superadmin};}

// Registration deliberately separate from bootstrap; never enable until all
// data migrations, classifier, email and concurrency paths have been verified.
export function registerCommercialTeamRoutes(app,{api,authUserFromBearer,logger=console}={}) {
 if(!api||typeof authUserFromBearer!=='function')throw Error('COMMERCIAL_TEAM_ROUTES_CONFIG_INVALID');
 const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{const user=await authUserFromBearer(req);return res.json(await fn(user,req));}catch(e){const status=[400,401,403,404,409].includes(e?.status)?e.status:503;logger?.error?.('[commercial-team]',{code:e?.code||'UNAVAILABLE'});return res.status(status).json({error:e?.code||'UNAVAILABLE'});}};
 app.get('/api/admin/crm/commercial-role',handle(u=>api.role(u)));
 app.get('/api/admin/crm/commercial-case-by-conversation/:id',handle((u,r)=>api.resolveConversation(u,r.params.id)));
 app.get('/api/admin/crm/commercial-cases',handle(u=>api.list(u)));
 app.get('/api/admin/crm/commercial-cases/:id',handle((u,r)=>api.read(u,r.query.channel,r.params.id)));
 app.put('/api/admin/crm/commercial-cases/:id/assignment',handle((u,r)=>api.assign(u,r.body?.channel,r.params.id,r.body?.advisorId,r.body?.expectedVersion)));
 app.get('/api/admin/crm/commercial-advisors',handle(u=>api.advisors(u)));
 app.post('/api/admin/crm/commercial-advisors',handle((u,r)=>api.addAdvisor(u,r.body?.email)));
 app.patch('/api/admin/crm/commercial-advisors/:id',handle((u,r)=>{if(r.body?.active!==false)throw fail(400,'INVALID_OPERATION');return api.disableAdvisor(u,r.params.id)}));
 app.put('/api/admin/crm/commercial-cases/:id/progress',handle((u,r)=>api.progress(u,r.body?.channel,r.params.id,r.body?.expectedVersion,r.body?.state,r.body?.nextStep,r.body?.nextContactAt,r.body?.reminderHours)));
 app.post('/api/admin/crm/commercial-cases/:id/followup/start',handle((u,r)=>api.followupStart(u,r.body?.channel,r.params.id,r.body?.language,r.body?.consentEvidence,r.body?.templateKey)));
 app.post('/api/admin/crm/commercial-cases/:id/followup/cancel',handle((u,r)=>api.followupCancel(u,r.body?.channel,r.params.id)));
 app.get('/api/admin/crm/commercial-cases/:id/activities',handle((u,r)=>api.activities(u,r.query.channel,r.params.id)));
 app.post('/api/admin/crm/commercial-cases/:id/activities',handle((u,r)=>api.activity(u,r.body?.channel,r.params.id,r.body?.body)));
 app.get('/api/admin/crm/commercial-cases/:id/calls',handle((u,r)=>api.calls(u,r.query.channel,r.params.id)));
 app.post('/api/admin/crm/commercial-cases/:id/calls',handle((u,r)=>api.openCall(u,r.body?.channel,r.params.id)));
 app.post('/api/admin/crm/commercial-cases/:id/calls/:callId/complete',handle((u,r)=>api.completeCall(u,r.body?.channel,r.params.id,r.params.callId,r.body?.situation,r.body?.discussed,r.body?.distinguishing)));
 app.get('/api/admin/crm/commercial-cases/:id/events/:eventId/media',async(req,res)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');try{const user=await authUserFromBearer(req);const result=await api.media(user,req.params.id,req.params.eventId);res.set('Content-Type','application/octet-stream');res.set('Content-Disposition',`attachment; filename="${result.filename}"`);return res.status(200).send(result.buffer);}catch(e){const status=[400,401,403,404,409,413].includes(e?.status)?e.status:503;logger?.error?.('[commercial-media]',{code:e?.code||'UNAVAILABLE'});return res.status(status).json({error:e?.code||'UNAVAILABLE'});}});
 app.post('/api/admin/crm/commercial-cases/:id/reply',handle((u,r)=>api.reply(u,r.body?.channel,r.params.id,r.body?.body,r.body?.requestId)));
}
