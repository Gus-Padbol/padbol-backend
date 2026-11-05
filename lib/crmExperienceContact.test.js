import test from 'node:test';
import assert from 'node:assert/strict';
import {registerCrmInboundRoutes} from './crmInboundRoutes.js';
const original='11111111-1111-4111-8111-111111111111';
const own='22222222-2222-4222-8222-222222222222';
async function invoke({contact={id:'contact-a',email_normalized:'a@example.com',phone_normalized:'5491112345678'},ambiguous=false,originalContact='contact-a',auth='Bearer test-key',whatsappConsent,pool,previousEligibility='allowed'}={}) {
 const routes=new Map();let ingested=null;let permission=null;const notes=[];
 pool ||= {query:async(sql,params)=>{if(sql.startsWith('select c.id')){assert.match(sql,/c.test_hidden_at is null/);assert.match(sql,/c.email_return_linked_to is null/);assert.match(sql,/crm_commercial_form_is_allowed\(c.id\)/);assert.match(sql,/coalesce\(f.progress_state,c.estado\)<>'cerrado'/);return {rows:sql.includes('where c.id=$1')&&previousEligibility==='allowed'?[{id:original}]:[]};}if(sql.startsWith('update')){permission=JSON.parse(params[1]);return {rows:[{id:params[0]}]};}return {rows:[]};}};
 registerCrmInboundRoutes({post:(path,...handlers)=>routes.set(path,handlers.at(-1))},{formInboundSecret:'test-key',logger:{warn(){}},pool,crmService:{createActivity:async note=>{notes.push(note);return {id:"activity"};},findOrCreateContact:async()=>({contact,ambiguous}),getConversation:async id=>({id,contact_id:originalContact}),ingestInbound:async ingest=>{ingested=ingest;return {conversation:{id:own}};}}});
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 await routes.get('/api/inbound/crm/experience/contact')({headers:{authorization:auth},body:{name:'Visitante',email:'A@example.com',phone:'+54 9 11 1234 5678',preferredContact:whatsappConsent === true ? 'whatsapp' : 'email',whatsappConsent,conversationId:original}},res);
 return {res,ingested,permission,notes};
}
test('same email and WhatsApp retain the original enquiry without new intake',async()=>{const {res,ingested}=await invoke();assert.equal(res.body.conversationId,original);assert.equal(ingested,null);assert.deepEqual(Object.keys(res.body).sort(),['conversationId','ok']);});
test('forwarded invitation never attributes another visitor to the original contact',async()=>{const {res,ingested}=await invoke({originalContact:'someone-else'});assert.equal(res.body.conversationId,own);assert.equal(ingested.email,'a@example.com');assert.equal(ingested.qualificationData.welcome_consent?.accepted ?? false,false);});
test('different WhatsApp does not reuse the original conversation',async()=>{const {res}=await invoke({contact:{id:'contact-a',email_normalized:'a@example.com',phone_normalized:'5491199999999'}});assert.equal(res.body.conversationId,own);});
test('conflicting identity stops for review, rather than merging enquiries',async()=>{const {res,ingested}=await invoke({ambiguous:true});assert.equal(res.statusCode,409);assert.equal(ingested,null);});
test('contact intake requires server credentials',async()=>{const {res}=await invoke({auth:''});assert.equal(res.statusCode,401);});

test('WhatsApp permission is affirmative, request-scoped and recorded with phone and timestamp',async()=>{const {permission,notes}=await invoke({whatsappConsent:true});assert.equal(permission.accepted,true);assert.equal(permission.scope,'respond_to_this_request');assert.equal(permission.phone,'5491112345678');assert.ok(Date.parse(permission.recordedAt));assert.match(notes[0].summary,/No autoriza campañas/);});
test('unchecked or absent WhatsApp permission stays false and directs email response',async()=>{for(const value of [false,undefined,'true']){const {permission,notes,res}=await invoke({whatsappConsent:value});assert.equal(res.statusCode,200);assert.equal(permission.accepted,false);assert.match(notes[0].summary,/correo electrónico/);}});

test('hidden, linked, closed or non-commercial invitations never reuse the old enquiry',async()=>{for(const previousEligibility of ['hidden','linked','closed','non-commercial']){const {res,ingested}=await invoke({previousEligibility});assert.equal(res.statusCode,200);assert.equal(res.body.conversationId,own);assert.ok(ingested);assert.equal(ingested.qualificationData.welcome_consent?.accepted ?? false,false);}});
