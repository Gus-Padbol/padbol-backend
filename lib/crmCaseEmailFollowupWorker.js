import {createCaseEmailFollowup} from './crmCaseEmailFollowup.js';
export function caseEmailWorkerConfig(env={}){
 const enabled=env.CRM_CASE_EMAIL_FOLLOWUP_ENABLED==='true'&&env.CRM_OUTBOUND_EMAIL_ENABLED==='true';
 return {enabled,reason:!enabled?'case-email-followup-disabled':'ready',doesNotUseBackgroundJobs:true};
}
export function createCaseEmailFollowupWorker({pool,sendEmail,env=process.env,intervalMs=60000,logger=console,now=()=>new Date()}={}){
 const config=caseEmailWorkerConfig(env);const service=createCaseEmailFollowup({pool,sendEmail,now,logger});let timer=null,running=false;
 async function runOnce(){if(running)return {status:'busy'};running=true;try{await service.recoverStale({olderThanMinutes:15});const claimed=await service.claimDispatch({limit:20});const results=[];for(const dispatch of claimed)results.push(await service.deliver({dispatch}));return {status:'ok',claimed:claimed.length,results};}catch(e){logger?.error?.('[crm-case-email-worker]',{code:e?.code||'UNAVAILABLE'});return {status:'error',reason:e?.code||'UNAVAILABLE'};}finally{running=false;}}
 function start(){if(!config.enabled)return {started:false,reason:config.reason};if(timer)return {started:true,already:true};timer=setInterval(()=>{void runOnce();},Math.max(60000,Number(intervalMs)||60000));if(timer.unref)timer.unref();return {started:true};}
 function stop(){if(timer){clearInterval(timer);timer=null;}return {stopped:true};}
 return {start,stop,runOnce,inspect:()=>config};
}
