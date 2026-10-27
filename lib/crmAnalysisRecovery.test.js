import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverFormAnalysis, recoverableFormAnalysis } from './crmAnalysisRecovery.js';
const row = { id:'case', source_ref:'source', source_channel:'email', origin:'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo', qualification_data: { routing:{workflow:'commercial_lead'}, form_submission:{form:'commercial',fields:{País:'US'}}, lead_analysis_request:{status:'disabled'} },contact:{nombre:'Person'},inbound_body:'original' };
test('historical recovery only allows explicit disabled commercial forms without analysis',()=>{
 assert.equal(recoverableFormAnalysis(row,['case']),true);
 for(const changed of [{id:'other'},{source_channel:'whatsapp'},{test_hidden_at:'now'},{qualification_data:{...row.qualification_data,lead_analysis:{score:60}}},{qualification_data:{...row.qualification_data,lead_analysis_request:{status:'pending'}}},{qualification_data:{...row.qualification_data,routing:{workflow:'support'}}}]) assert.equal(recoverableFormAnalysis({...row,...changed},['case']),false);
});
test('dry run makes no writes or provider calls; CAS recovery preserves original data',async()=>{
 let writes=0,calls=0;const repository={async updateLeadAnalysis(id,next,previous){writes++;assert.equal(previous,row.qualification_data);assert.equal(next.form_submission,previous.form_submission);return {...row,qualification_data:next};}};
 const analyzer=async({ingest})=>{calls++;assert.equal(ingest.sourceId,'source');assert.equal(ingest.body,'original');assert.equal(ingest.qualificationData.form_submission.fields.País,'US');return {status:'accepted'};};
 assert.equal((await recoverFormAnalysis({row,allowedIds:['case'],repository,analyzer})).status,'eligible');assert.equal(writes,0);assert.equal(calls,0);
 assert.equal((await recoverFormAnalysis({row,allowedIds:['case'],repository,analyzer,apply:true})).status,'accepted');assert.equal(writes,1);assert.equal(calls,1);
 assert.equal((await recoverFormAnalysis({row,allowedIds:['case'],repository:{updateLeadAnalysis:async()=>null},analyzer,apply:true})).status,'concurrent_update');assert.equal(calls,1);
});
