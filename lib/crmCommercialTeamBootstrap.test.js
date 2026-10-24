import {test} from 'node:test';import assert from 'node:assert/strict';import {initializeCommercialRollout} from './crmCommercialTeamBootstrap.js';
test('exactly one route owner and verification gates fail closed',()=>{
 let legacy=0;const legacyBootstrap=()=>{legacy++;return{enabled:true,mode:'legacy'}};const routes=[];const app={get:p=>routes.push(['get',p]),post:p=>routes.push(['post',p]),put:p=>routes.push(['put',p]),patch:p=>routes.push(['patch',p])};
 assert.equal(initializeCommercialRollout({app,legacyBootstrap,env:{}}).mode,'legacy');assert.equal(legacy,1);
 assert.equal(initializeCommercialRollout({app,legacyBootstrap,env:{CRM_COMMERCIAL_TEAM_ENABLED:'true'}}).mode,'legacy');assert.equal(legacy,2);assert.equal(routes.length,0);
 const env={CRM_COMMERCIAL_TEAM_ENABLED:'true',CRM_COMMERCIAL_CASES_ENABLED:'true',CRM_COMMERCIAL_CASES_RECOVERY_VERIFIED:'true',CRM_COMMERCIAL_TEAM_VERIFIED:'true',CRM_COMMERCIAL_CASES_DATABASE_URL:'fixture',CRM_WHATSAPP_CHANNEL_ID:'11111111-1111-4111-8111-111111111111',CRM_WHATSAPP_PHONE_NUMBER_ID:'1376102838911694'};
 const result=initializeCommercialRollout({app,legacyBootstrap,env,db:{rpc(){},from(){}},authUserFromBearer:async()=>null,resolveTrustedSuperadmin:async()=>false,manualWhatsappSender:async()=>{},emailSender:async()=>{},poolFactory:()=>({connect(){}})});
 assert.equal(result.mode,'team');assert.equal(legacy,2);assert.equal(routes.filter(([method,path])=>method==='get'&&path==='/api/admin/crm/commercial-cases').length,1);assert.equal(routes.some(([,path])=>path==='/api/admin/crm/commercial-review'),false);
 const more=[];const app2={get:p=>more.push(['get',p]),post:p=>more.push(['post',p]),put:p=>more.push(['put',p]),patch:p=>more.push(['patch',p])};
 initializeCommercialRollout({app:app2,legacyBootstrap,env:{...env,CRM_COMMERCIAL_REVIEW_VERIFIED:'true'},db:{rpc(){},from(){}},authUserFromBearer:async()=>null,resolveTrustedSuperadmin:async()=>false,manualWhatsappSender:async()=>{},emailSender:async()=>{},poolFactory:()=>({connect(){}})});
 assert.equal(more.filter(([method,path])=>method==='get'&&path==='/api/admin/crm/commercial-cases').length,1);
});
