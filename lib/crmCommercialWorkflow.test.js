import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService } from './crmAdmin.js';

const nico = { email:'sm@padbol.com', id:'7225442b-defd-42c1-a5a2-b9c1c339fa69' };
const conversation = { id:'11111111-1111-4111-8111-111111111111', contact_id:'22222222-2222-4222-8222-222222222222', source_channel:'email', origin:'web_form:solicitud_licencia', qualification_data:{ routing:{workflow:'commercial_lead'} } };
function repository() {
  const calls=[]; let workflow={ case:{ conversation_id:conversation.id, version:0, stage:'new', assigned_user_id:null }, interactions:[] };
  return {
    calls, getConversation:async id=>id===conversation.id?conversation:null,
    getCommercialWorkflow:async()=>workflow,
    assignCommercialCase:async payload=>{calls.push(['assign',payload]);workflow={...workflow,case:{...workflow.case,assigned_user_id:payload.assigneeId,version:1,stage:'active'}};return workflow.case;},
    recordCommercialInteraction:async payload=>{calls.push(['interaction',payload]);workflow={...workflow,case:{...workflow.case,version:2,stage:payload.stage}};return {case:workflow.case,interaction:payload};},
    activateCommercialFollowup:async payload=>{calls.push(['followup',payload]);return {...workflow.case,followup_enabled:true,version:3};},
  };
}
function service(repo=repository()) { return [createCrmAdminService({repository:repo,commercialOperators:[{email:nico.email,userId:nico.id}]}),repo]; }
const ctx={email:nico.email,role:null,userId:nico.id};

test('commercial workflow refuses a closure without required summary and outcome', async()=>{
 const [s]=service();
 await assert.rejects(()=>s.recordCommercialInteraction({...ctx,id:conversation.id,kind:'call',summary:'',outcome:'',stage:'won',version:0}),e=>e.code==='CRM_COMMERCIAL_SUMMARY_REQUIRED');
});
test('waiting requires an explicit next action and date', async()=>{
 const [s]=service();
 await assert.rejects(()=>s.recordCommercialInteraction({...ctx,id:conversation.id,kind:'call',summary:'Se conversó sobre el proyecto.',outcome:'Pidió tiempo para revisar.',stage:'waiting',version:0}),e=>e.code==='CRM_COMMERCIAL_SUMMARY_REQUIRED');
});
test('assignment, recorded result and manual followup have optimistic versions', async()=>{
 const [s,r]=service();
 const assignee=nico.id;
 await s.assignCommercial({...ctx,id:conversation.id,assigneeId:assignee,note:'Inglaterra',version:0});
 await s.recordCommercialInteraction({...ctx,id:conversation.id,kind:'call',summary:'Hablamos de abrir una sede en Londres.',outcome:'Solicitó una semana para evaluar.',stage:'waiting',nextAction:'Llamar la próxima semana.',nextActionAt:'2026-11-01T15:00:00.000Z',version:1});
 await s.activateCommercialFollowup({...ctx,id:conversation.id,plan:'Seguimiento personalizado acordado',version:2});
 assert.equal(r.calls.map(([name])=>name).join(','),'assign,interaction,followup');
 assert.equal(r.calls[2][1].plan,'Seguimiento personalizado acordado');
});
test('only the assigned advisor may log the interaction', async()=>{
 const [s,r]=service(); r.getCommercialWorkflow=async()=>({case:{...r.getCommercialWorkflow,assigned_user_id:'33333333-3333-4333-8333-333333333333',version:0,stage:'active'},interactions:[]});
 await assert.rejects(()=>s.recordCommercialInteraction({...ctx,id:conversation.id,kind:'call',summary:'Resumen suficiente.',outcome:'Resultado suficiente.',stage:'active',version:0}),e=>e.code==='CRM_COMMERCIAL_ASSIGNED_TO_OTHER');
});
