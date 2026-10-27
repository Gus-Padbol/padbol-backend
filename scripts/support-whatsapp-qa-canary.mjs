// Private server CLI. No dotenv loading, HTTP endpoint, scheduler or retry loop.
// Run only with already-provisioned QA service configuration and explicit consent.
import pg from 'pg';
import {createSupportWhatsappQaCanaryCandidate} from '../lib/supportWhatsappQaCanaryCandidate.js';
let pool;
try{
 if(process.env.CRM_SUPPORT_QA_CANARY_ENABLED!=='true')throw Error('SUPPORT_QA_CANARY_DISABLED');
 if(!process.env.DATABASE_URL)throw Error('SUPPORT_QA_CANARY_DATABASE_REQUIRED');
 pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:2});
 const canary=createSupportWhatsappQaCanaryCandidate({pool});
 const result=await canary.runOnce();
 // No recipient, body, token, connection string or provider response in logs.
 console.log(JSON.stringify({status:result.status,sent:result.sent===true,retryAllowed:false}));
 if(!result.sent)process.exitCode=2;
}catch{console.error('Support QA canary blocked or unconfirmed; do not retry automatically.');process.exitCode=1}
finally{await pool?.end()}
