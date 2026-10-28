import pg from 'pg';

// Private operator tool. No mailbox content, credentials or customer identity is
// accepted on the command line or printed. Dry-run is the default.
const args=process.argv.slice(2),apply=args.includes('--apply'),values={};
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'');
let client;
try{
 for(let i=0;i<args.length;i++){
  if(args[i]==='--apply')continue;
  if(!['--actor','--conversation','--advisor','--reason'].includes(args[i])||values[args[i]]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENTS');
  values[args[i]]=args[++i];
 }
 const actor=values['--actor'],conversation=values['--conversation'],advisor=values['--advisor'];
 const reason=values['--reason']||'Consulta comercial recibida por correo y verificada por administración central.';
 if(!uuid(actor)||!uuid(conversation)||!uuid(advisor)||reason.trim().length<10||reason.length>2000)throw Error('INVALID_ARGUMENTS');
 if(apply&&process.env.CRM_COMMERCIAL_EMAIL_TRIAGE_ENABLED!=='true')throw Error('TRIAGE_NOT_ENABLED');
 const connectionString=process.env.CRM_COMMERCIAL_CASES_DATABASE_URL||process.env.DATABASE_URL;
 if(!connectionString)throw Error('DATABASE_NOT_CONFIGURED');
 client=new pg.Client({connectionString});await client.connect();
 const owner=(await client.query('select public.crm_commercial_owner($1,true) allowed',[actor])).rows[0]?.allowed;
 if(owner!==true)throw Error('OWNER_NOT_VERIFIED');
 const advisorReady=(await client.query('select public.crm_commercial_team_case_allowed($1,false,$1) ready',[advisor])).rows[0]?.ready===true;
 const row=(await client.query(`select c.id,c.source_channel,c.origin,c.test_hidden_at is not null hidden,c.email_return_linked_to is not null linked,
  exists(select 1 from public.crm_inbound_events e where e.conversation_id=c.id and e.source_channel='email' and e.origin=c.origin) has_original_email,
  exists(select 1 from public.crm_commercial_email_triage t where t.conversation_id=c.id) classified,
  (select assigned_user_id from public.crm_commercial_form_cases f where f.conversation_id=c.id) current_advisor
  from public.crm_conversations c where c.id=$1`,[conversation])).rows[0];
 if(!row)throw Error('CONVERSATION_NOT_FOUND');
 const eligible=row.source_channel==='email'&&row.origin==='institutional_email'&&!row.hidden&&!row.linked&&row.has_original_email;
 if(!apply){console.log(JSON.stringify({dryRun:true,conversationId:row.id,origin:row.origin,eligible,advisorReady,readyToApply:eligible&&advisorReady&&process.env.CRM_COMMERCIAL_EMAIL_TRIAGE_ENABLED==='true',alreadyClassified:row.classified,currentAdvisorId:row.current_advisor||null}));}
 else{
  if(!eligible)throw Error('EMAIL_NOT_ELIGIBLE');
  const result=(await client.query('select public.crm_commercial_email_classify($1,$2,$3,$4) result',[actor,conversation,advisor,reason.trim()])).rows[0].result;
  console.log(JSON.stringify({applied:true,...result}));
 }
}catch(error){
 const known=new Set(['INVALID_ARGUMENTS','TRIAGE_NOT_ENABLED','DATABASE_NOT_CONFIGURED','OWNER_NOT_VERIFIED','CONVERSATION_NOT_FOUND','EMAIL_NOT_ELIGIBLE']);
 console.error(JSON.stringify({ok:false,code:known.has(error.message)?error.message:'TRIAGE_OPERATION_FAILED'}));process.exitCode=1;
}finally{await client?.end();}
