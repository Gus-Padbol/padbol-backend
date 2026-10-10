import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmLeadAutoAnalyzer } from './crmLeadAutoAnalysis.js';
import { createCrmService, createSupabaseCrmRepository } from './crmService.js';

test('provider rejection, malformed output and timeout persist failure without pretending a result', async () => {
 for (const kind of ['rejected','malformed','timeout']) {
  let failed; let attached=0;
  const analyzer=createCrmLeadAutoAnalyzer({env:{OPENAI_API_KEY:'mock'},timeoutMs:5,logger:{},crmService:{markLeadAnalysisFailed:async p=>{failed=p},attachLeadAnalysis:async()=>{attached++}},fetchImpl:async(_url,{signal})=>{
   if(kind==='rejected')return {ok:false,status:401};
   if(kind==='malformed')return {ok:true,json:async()=>({output_text:'invalid'})};
   return new Promise((resolve,reject)=>{const keeper=setTimeout(()=>reject(Error('timeout was not applied')),100);signal.addEventListener('abort',()=>{clearTimeout(keeper);reject(signal.reason)},{once:true})});
  }});
  await assert.rejects(analyzer({ingest:{sourceId:'fixture'}}));assert.deepEqual(failed,{sourceId:'fixture'});assert.equal(attached,0);
 }
});
test('failure audit rejection preserves the original provider failure', async()=>{
 const analyzer=createCrmLeadAutoAnalyzer({env:{OPENAI_API_KEY:'mock'},logger:{error(){}},crmService:{markLeadAnalysisFailed:async()=>{throw Error('db secret')}},fetchImpl:async()=>({ok:false,status:503})});
 await assert.rejects(analyzer({ingest:{sourceId:'fixture'}}),/CRM_LEAD_ANALYSIS_PROVIDER_503/);
});
test('failure changes only a pending request and preserves all original fields',async()=>{
 const previous={form_submission:{fields:{consent:false}},lead_analysis_request:{status:'pending',request_id:'same'}};let update;
 const service=createCrmService({now:()=>new Date('2026-10-10T00:00:00Z'),repository:{findConversationBySourceRef:async()=>({id:'c',qualification_data:previous}),updateLeadAnalysisFailure:async(id,expected,next)=>{update={id,expected,next};return {id}}}});
 assert.equal((await service.markLeadAnalysisFailed({sourceId:'source'})).status,'failed');assert.equal(update.expected,previous);assert.equal(update.next.form_submission,previous.form_submission);assert.equal(update.next.lead_analysis_request.request_id,'same');assert.equal(update.next.lead_analysis_request.status,'failed');
});
test('historical results, disabled/completed requests and concurrent updates are never overwritten',async()=>{
 for(const qualification_data of [{lead_analysis:{score:70},lead_analysis_request:{status:'pending'}},{lead_analysis_request:{status:'disabled'}},{lead_analysis_request:{status:'completed'}},{}]){
  const service=createCrmService({repository:{findConversationBySourceRef:async()=>({id:'c',qualification_data}),updateLeadAnalysisFailure:async()=>assert.fail('must not write')}});assert.equal((await service.markLeadAnalysisFailed({sourceId:'source'})).status,'unchanged');
 }
 const service=createCrmService({repository:{findConversationBySourceRef:async()=>({id:'c',qualification_data:{lead_analysis_request:{status:'pending'}}}),updateLeadAnalysisFailure:async()=>null}});assert.equal((await service.markLeadAnalysisFailed({sourceId:'source'})).status,'unchanged');
});
test('repository failure write compares original JSON and rejects persistence errors',async()=>{
 const calls=[];let error=null;const builder={update:p=>{calls.push(['update',p]);return builder},eq:(k,v)=>{calls.push(['eq',k,v]);return builder},select:()=>builder,maybeSingle:async()=>({data:null,error})};const repo=createSupabaseCrmRepository({from:()=>builder});const previous={lead_analysis_request:{status:'pending'}};
 assert.equal(await repo.updateLeadAnalysisFailure('c',previous,{lead_analysis_request:{status:'failed'}}),null);assert.ok(calls.some(c=>c[1]==='qualification_data'&&c[2]===JSON.stringify(previous)));error={code:'bad'};await assert.rejects(repo.updateLeadAnalysisFailure('c',previous,{}));
});
