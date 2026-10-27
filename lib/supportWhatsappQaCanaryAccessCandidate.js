import express from 'express';
import {createHash} from 'node:crypto';
import {createSupportWhatsappQaCanaryCandidate} from './supportWhatsappQaCanaryCandidate.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const exactQa=env=>env.BACKEND_RUNTIME_MODE==='staging'&&env.STAGING_SUPABASE_PROJECT_REF==='vxikhdulhuvghfqeutnp'&&env.SUPABASE_URL==='https://vxikhdulhuvghfqeutnp.supabase.co'&&env.RENDER_SERVICE_ID==='srv-dahbs0dbedkc73a0kf4g'&&env.RENDER_EXTERNAL_URL==='https://padbol-backend-qa.onrender.com';
// Capture only the exact QA environment's transport before the global guard.
// DB approval is separate from both Mini preparation and the manual sender.
export function createSupportWhatsappQaCanaryAccessFactory({env=process.env,fetchImpl=globalThis.fetch,canaryFactory=createSupportWhatsappQaCanaryCandidate}={}){
 if(!exactQa(env))return null;
 const captured={...env};
 return function mount(app,{pool}={}){
  if(!pool?.query||!pool?.connect)return{mounted:false};
  const router=express.Router();router.use(express.json({limit:'1kb'}));
  router.use(async(req,res,next)=>{
   const token=/^Bearer ([A-Za-z0-9_-]{32,180})$/.exec(req.headers.authorization||'')?.[1];
   if(!token)return res.status(401).json({code:'SUPPORT_QA_CANARY_UNAUTHENTICATED'});
   req.canaryTokenHash=hash(token);
   try{const row=(await pool.query('select singleton from public.crm_support_qa_canary_access where token_sha256=$1',[req.canaryTokenHash])).rows[0];if(!row)return res.status(401).json({code:'SUPPORT_QA_CANARY_UNAUTHENTICATED'});next()}catch{return res.status(503).json({code:'SUPPORT_QA_CANARY_NOT_CONFIGURED'})}
  });
  router.get('/status',async(req,res)=>{
   try{const row=(await pool.query(`select enabled,security_approved,effect_id is not null and principal_id is not null and authorized_recipient is not null configured,exists(select 1 from public.crm_support_qa_canary_permits) quota_consumed from public.crm_support_qa_canary_access where token_sha256=$1`,[req.canaryTokenHash])).rows[0];
    if(!row)return res.status(401).json({code:'SUPPORT_QA_CANARY_UNAUTHENTICATED'});
    return res.json({mode:'qa_run_once',enabled:row.enabled===true,securityApproved:row.security_approved===true,configured:row.configured===true,quotaConsumed:row.quota_consumed===true,automaticSweep:false,retryAllowed:false});
   }catch{return res.status(503).json({code:'SUPPORT_QA_CANARY_NOT_CONFIGURED'})}
  });
  let running=false;
  router.post('/run-once',async(req,res)=>{
   if(req.body&&(![Object.prototype,null].includes(Object.getPrototypeOf(req.body))||Object.keys(req.body).length))return res.status(400).json({code:'SUPPORT_QA_CANARY_BODY_FORBIDDEN'});
   if(running)return res.status(409).json({code:'SUPPORT_QA_CANARY_IN_PROGRESS',retryAllowed:false});
   running=true;let c;
   try{
    c=await pool.connect();await c.query('begin');
    const row=(await c.query('select * from public.crm_support_qa_canary_access where token_sha256=$1 for update',[req.canaryTokenHash])).rows[0];
    if(!row){await c.query('rollback');return res.status(401).json({code:'SUPPORT_QA_CANARY_UNAUTHENTICATED'})}
    if(row.enabled!==true||row.security_approved!==true){await c.query('rollback');return res.status(409).json({code:'SUPPORT_QA_CANARY_APPROVAL_REQUIRED',retryAllowed:false})}
    const canary=canaryFactory({env:{...captured,CRM_SUPPORT_QA_CANARY_ENABLED:'true',CRM_SUPPORT_QA_CANARY_SECURITY_APPROVED:'true',CRM_SUPPORT_QA_CANARY_EFFECT_ID:String(row.effect_id||''),CRM_SUPPORT_QA_CANARY_PRINCIPAL_ID:row.principal_id||'',CRM_SUPPORT_QA_CANARY_AUTHORIZED_RECIPIENT:row.authorized_recipient||''},pool,fetchImpl});
    const result=await canary.runOnce();await c.query('commit');
    return res.status(result.sent?200:409).json({status:result.status,sent:result.sent===true,retryAllowed:false});
   }catch{await c?.query('rollback').catch(()=>{});return res.status(503).json({code:'SUPPORT_QA_CANARY_BLOCKED_OR_UNCONFIRMED',retryAllowed:false})}
   finally{c?.release();running=false}
  });
  app.use('/api/internal/support-qa-canary',router);
  return{mounted:true,mode:'qa_run_once',automaticSweep:false};
 };
}
