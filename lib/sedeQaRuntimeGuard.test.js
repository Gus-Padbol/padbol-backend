import test from 'node:test';
import assert from 'node:assert/strict';
import {createQaGuardedPool,mountSedeQaDiagnostic,mountQaLegacyAdmission,QA_PROJECT,QA_SERVICE,QA_URL} from './sedeQaRuntimeGuard.js';
const actor='11111111-1111-4111-8111-111111111111';
const env={RENDER_SERVICE_ID:QA_SERVICE,RENDER_EXTERNAL_URL:QA_URL,SUPABASE_URL:`https://${QA_PROJECT}.supabase.co`,STAGING_SUPABASE_PROJECT_REF:QA_PROJECT,RENDER_GIT_COMMIT:'a'.repeat(40)};
const runtime={staging:true,mode:'staging',outboundDeliveryEnabled:false,backgroundJobsEnabled:false,pushSendEnabled:false};
function fixture({params={},row={},failAt=null}={}){
 const calls=[],releases=[];
 const c={connectionParameters:{host:`db.${QA_PROJECT}.supabase.co`,user:'postgres',database:'postgres',...params},
 query:async(sql,args)=>{calls.push([sql,args]);if(sql===failAt)throw Error('SECRET_MUST_NOT_LEAK');return {rows:[{database_name:'postgres',sql_role:'postgres',isolation:'read committed',readonly:'on',actor_authorized:true,...row}]};},release:discard=>releases.push(discard)};
 return {c,calls,releases,pool:{connect:async()=>c}};
}
async function request(f,options={}){
 let handler;mountSedeQaDiagnostic({get:(_p,h)=>handler=h},{pool:f.pool,runtime,env,authUserFromBearer:async()=>({id:actor}),assertSuperAdminReq:async()=>{},...options});
 const res={statusCode:200,status(n){this.statusCode=n;return this},json(value){this.body=value;return this}};
 if(handler)await handler({body:{actorId:'forged'},query:{actorId:'forged'}},res);return {res,handler};
}
test('readonly authenticated diagnostic ignores forged actor and exposes only allowlisted evidence',async()=>{
 const f=fixture(),{res}=await request(f);assert.equal(res.statusCode,200);assert.deepEqual(res.body,{ok:true,targetQA:true,actorAuthorized:true,readOnly:true,isolation:'read committed',release:env.RENDER_GIT_COMMIT});
 assert.deepEqual(f.calls.map(x=>x[0]).filter(x=>!x.startsWith('SELECT')),['BEGIN READ ONLY',"SET LOCAL statement_timeout='3000ms'",'ROLLBACK']);assert.deepEqual(f.calls.find(x=>x[0].startsWith('SELECT'))[1],[actor]);assert.deepEqual(f.releases,[undefined]);
});
test('auth401 and HTTPsuperadmin403 precede any pool acquisition; database actor denial403',async()=>{
 for(const options of [{authUserFromBearer:async()=>null},{assertSuperAdminReq:async()=>{throw Object.assign(Error(),{status:403});}}]){const f=fixture(),{res}=await request(f,options);assert.equal(res.statusCode,options.authUserFromBearer?401:403);assert.equal(f.calls.length,0);}
 const f=fixture({row:{actor_authorized:false}}),{res}=await request(f);assert.equal(res.statusCode,403);assert.equal(f.calls.at(-1)[0],'ROLLBACK');assert.deepEqual(f.releases,[true]);
});
test('invalid or absent UUID cannot be replaced with caller body identity',async()=>{const f=fixture(),{res}=await request(f,{authUserFromBearer:async()=>({id:'invalid'})});assert.equal(res.statusCode,403);assert.equal(f.calls.length,0);});
test('target rejects production/direct lookalikes/wrong user/db/missing metadata before SQL',async()=>{
 for(const params of [{host:'db.vpldffhsxhgnmitiikof.supabase.co'},{host:`db.${QA_PROJECT}.supabase.co.evil`},{host:'aws-1.pooler.supabase.com',user:'postgres.production'},{host:'pooler.supabase.com.evil',user:`postgres.${QA_PROJECT}`},{user:'other'},{database:'other'},{host:null}]){const f=fixture({params});const {res}=await request(f);assert.equal(res.statusCode,503);assert.equal(f.calls.length,0);assert.deepEqual(f.releases,[true]);}
 const f=fixture();delete f.c.connectionParameters;assert.equal((await request(f)).res.statusCode,503);
});
test('exact official QA pooler accepted without exposing its username',async()=>{const f=fixture({params:{host:'aws-1-eu-west-1.pooler.supabase.com',user:`postgres.${QA_PROJECT}`}});const {res}=await request(f);assert.equal(res.statusCode,200);assert.equal(JSON.stringify(res.body).includes('postgres.'),false);});
test('role/isolation/readonly/database SQL mismatch rolls back and fails closed',async()=>{
 for(const row of [{sql_role:'service_role'},{isolation:'serializable'},{readonly:'off'},{database_name:'other'}]){const f=fixture({row}),{res}=await request(f);assert.equal(res.statusCode,503);assert.equal(f.calls.at(-1)[0],'ROLLBACK');assert.deepEqual(f.releases,[true]);}
});
test('runtime/project/service/url/commit/delivery guard rejects before connect',async()=>{
 for(const override of [{runtime:{...runtime,staging:false}},{runtime:{...runtime,outboundDeliveryEnabled:true}},{runtime:{...runtime,backgroundJobsEnabled:true}},{runtime:{...runtime,pushSendEnabled:true}},{env:{...env,RENDER_SERVICE_ID:'other'}},{env:{...env,RENDER_EXTERNAL_URL:'https://other'}},{env:{...env,SUPABASE_URL:'https://prod.supabase.co'}},{env:{...env,STAGING_SUPABASE_PROJECT_REF:'prod'}},{env:{...env,RENDER_GIT_COMMIT:''}}]){const f=fixture(),{res}=await request(f,override);assert.equal(res.statusCode,503);assert.equal(f.calls.length,0);}
});
test('SQL timeout and rollback error safely discard client, errors never escape',async()=>{
 for(const failAt of ["SET LOCAL statement_timeout='3000ms'",'ROLLBACK','BEGIN READ ONLY']){const f=fixture({failAt}),{res}=await request(f);assert.equal(res.statusCode,503);assert.equal(JSON.stringify(res).includes('SECRET'),false);assert.deepEqual(f.releases,[true]);if(failAt.startsWith('SET'))assert.equal(f.calls.at(-1)[0],'ROLLBACK');}
});
test('guard covers connect and direct pool.query worker claims/acks; future lease rechecked',async()=>{
 const f=fixture(),pool=createQaGuardedPool(f.pool,{runtime,env});const c=await pool.connect();await c.query('BEGIN');c.release();await pool.query('UPDATE synthetic SET value=1');assert.equal(f.calls.filter(x=>x[0]==='BEGIN READ ONLY').length,2);
 f.c.connectionParameters.host='db.production.supabase.co';const n=f.calls.length;await assert.rejects(pool.query('UPDATE synthetic SET value=2'));assert.equal(f.calls.length,n);await assert.rejects(pool.connect());
});
test('production unchanged, QA accidental production mode still blocked, probe not public in production',async()=>{
 const f=fixture(),prod={...runtime,staging:false,mode:'production'};assert.equal(createQaGuardedPool(f.pool,{runtime:prod,env:{}}),f.pool);assert.equal((await request(f,{runtime:prod,env:{}})).handler,undefined);await assert.rejects(createQaGuardedPool(f.pool,{runtime:prod,env}).connect());
});
test('legacy capability OFF blocks approval before fallback; rejection requires checked pool',async()=>{
 const handlers={};const f=fixture();mountQaLegacyAdmission({post:(p,h)=>handlers[p]=h},{runtime,env,pool:createQaGuardedPool(f.pool,{runtime,env}),enabled:false});
 let next=0;const res={status(n){this.statusCode=n;return this},json(b){this.body=b;return this}};await handlers['/api/admin/sedes-pendientes/:id/aprobar']({},res,()=>next++);assert.equal(res.statusCode,503);assert.equal(next,0);assert.equal(f.calls.length,0);
 await handlers['/api/admin/sedes-pendientes/:id/rechazar']({},res,()=>next++);assert.equal(next,1);f.c.connectionParameters.host='db.production.supabase.co';await handlers['/api/admin/sedes-pendientes/:id/rechazar']({},res,()=>next++);assert.equal(next,1);
});
