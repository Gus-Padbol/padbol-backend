import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveSupportExecutorMount,mountSupportExecutorCandidate} from './supportExecutorCandidate.js';
const qa={BACKEND_RUNTIME_MODE:'staging',STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co',RENDER_SERVICE_ID:'srv-dahbs0dbedkc73a0kf4g',RENDER_EXTERNAL_URL:'https://padbol-backend-qa.onrender.com'};
test('preparation endpoint mounts only exact QA, all five values mandatory',()=>{
 assert.equal(resolveSupportExecutorMount(qa).enabled,true);
 for(const key of Object.keys(qa))for(const value of [undefined,'wrong'])assert.equal(resolveSupportExecutorMount({...qa,[key]:value}).enabled,false,key);
 assert.equal(resolveSupportExecutorMount({}).enabled,false);
 assert.equal(resolveSupportExecutorMount({...qa,BACKEND_RUNTIME_MODE:'production',CRM_SUPPORT_EXECUTOR_ENABLED:'true'}).enabled,false);
 assert.equal(resolveSupportExecutorMount({...qa,CRM_SUPPORT_EXECUTOR_ENABLED:'false'}).enabled,false);
});
test('mount is preparation only, does not query DB/enable principal or sender, and missing DB is inert',()=>{
 let mounts=0;const app={use(path,router){assert.equal(path,'/api/internal/support-executor');assert.equal(typeof router,'function');mounts++}},pool={query(){throw Error('MUST_NOT_QUERY_ON_MOUNT')}};
 assert.equal(mountSupportExecutorCandidate(app,{pool,env:qa}).enabled,true);assert.equal(mounts,1);
 assert.equal(mountSupportExecutorCandidate(app,{pool:null,env:qa}).enabled,false);assert.equal(mounts,1);
 assert.deepEqual(resolveSupportExecutorMount(qa),{enabled:true,mode:'prepare',sendEnabled:false});
});
