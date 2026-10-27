// Internal preparation-only API. No user impersonation, sender, model or customer transport.
import express from 'express';
import {createHash} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=x=>createHash('sha256').update(x).digest('hex');
const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
export function validateExecutorProposal(value){
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='diagnosis,reply,steps,summary')throw fail('SUPPORT_EXECUTOR_PROPOSAL_INVALID',400);
 for(const key of ['summary','diagnosis','reply'])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>2000)throw fail('SUPPORT_EXECUTOR_PROPOSAL_INVALID',400);
 if(!Array.isArray(value.steps)||value.steps.length>10||value.steps.some(s=>typeof s!=='string'||!s.trim()||s.length>500))throw fail('SUPPORT_EXECUTOR_PROPOSAL_INVALID',400);
 return {summary:value.summary.trim(),diagnosis:value.diagnosis.trim(),reply:value.reply.trim(),steps:value.steps.map(x=>x.trim())};
}
export function createSupportExecutorRouter({pool}={}){
 if(!pool?.query)throw fail('SUPPORT_EXECUTOR_NOT_CONFIGURED',503);
 const router=express.Router();router.use(express.json({limit:'20kb'}));
 router.use(async(req,res,next)=>{
  const match=/^Bearer ([A-Za-z0-9_-]{32,180})$/.exec(req.headers.authorization||'');
  if(!match)return res.status(401).json({code:'SUPPORT_EXECUTOR_UNAUTHENTICATED'});
  try{const row=(await pool.query("select id from public.crm_support_executor_principals where token_sha256=$1 and enabled=true and capability='mini_prepare'",[digest(match[1])])).rows[0];if(!row)return res.status(401).json({code:'SUPPORT_EXECUTOR_UNAUTHENTICATED'});req.supportPrincipal=row.id;next()}catch{return res.status(503).json({code:'SUPPORT_EXECUTOR_NOT_CONFIGURED'})}
 });
 const reject=(res,error)=>{const known=String(error?.message||'');const code=error?.code?.startsWith?.('SUPPORT_EXECUTOR_')?error.code:known.startsWith('SUPPORT_EXECUTOR_')?known:'SUPPORT_EXECUTOR_UNAVAILABLE';return res.status(error.status||(/FORBIDDEN/.test(code)?403:/INVALID|CONFLICT|EXPIRED|CASE_STATE|CASE_SCOPE/.test(code)?409:503)).json({code});};
 router.get('/status',async(req,res)=>{try{const rows=(await pool.query('select state,count(*)::int count from crm_support_executor_jobs where principal_id=$1 or principal_id is null group by state',[req.supportPrincipal])).rows;return res.json({mode:'prepare',sendEnabled:false,principalType:'service',queue:rows})}catch(e){return reject(res,e)}});
 router.post('/jobs/claim',async(req,res)=>{try{const b=req.body||{};if(!UUID.test(b.requestId||'')||!UUID.test(b.workerId||''))throw fail('SUPPORT_EXECUTOR_REQUEST_INVALID',400);const data=(await pool.query('select crm_support_executor_claim($1,$2,$3,$4) result',[req.supportPrincipal,b.requestId,b.workerId,120])).rows[0].result;res.json(data)}catch(e){reject(res,e)}});
 router.post('/jobs/:id/complete',async(req,res)=>{try{const b=req.body||{};if(!UUID.test(req.params.id)||!UUID.test(b.leaseToken||'')||!UUID.test(b.completionId||''))throw fail('SUPPORT_EXECUTOR_REQUEST_INVALID',400);const proposal=validateExecutorProposal(b.proposal);const hash=digest(stable(proposal));const r=(await pool.query('select crm_support_executor_complete($1,$2,$3,$4,$5,$6) result',[req.supportPrincipal,req.params.id,b.leaseToken,b.completionId,hash,JSON.stringify(proposal)])).rows[0].result;res.json(r)}catch(e){reject(res,e)}});
 router.post('/jobs/:id/fail',async(req,res)=>{try{const b=req.body||{};if(!UUID.test(req.params.id)||!UUID.test(b.leaseToken||''))throw fail('SUPPORT_EXECUTOR_REQUEST_INVALID',400);const r=(await pool.query('select crm_support_executor_fail($1,$2,$3,$4) result',[req.supportPrincipal,req.params.id,b.leaseToken,b.code])).rows[0].result;res.json(r)}catch(e){reject(res,e)}});
 return router;
}
export function resolveSupportExecutorMount(env=process.env){
 const exactQa=env.BACKEND_RUNTIME_MODE==='staging'
  && env.STAGING_SUPABASE_PROJECT_REF==='vxikhdulhuvghfqeutnp'
  && env.SUPABASE_URL==='https://vxikhdulhuvghfqeutnp.supabase.co'
  && env.RENDER_SERVICE_ID==='srv-dahbs0dbedkc73a0kf4g'
  && env.RENDER_EXTERNAL_URL==='https://padbol-backend-qa.onrender.com';
 return {enabled:exactQa&&env.CRM_SUPPORT_EXECUTOR_ENABLED!=='false',mode:'prepare',sendEnabled:false};
}
export function mountSupportExecutorCandidate(app,{pool,env=process.env}={}){
 const gate=resolveSupportExecutorMount(env);
 if(!gate.enabled||!pool?.query)return {...gate,enabled:false};
 app.use('/api/internal/support-executor',createSupportExecutorRouter({pool}));
 return gate;
}
