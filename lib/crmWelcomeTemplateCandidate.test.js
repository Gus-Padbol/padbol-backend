import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWelcome, sendWelcomeCandidate} from './crmWelcomeTemplateCandidate.js';
const contact = {whatsapp_followup_consent:true, whatsapp_followup_consent_at:'2026-10-22T12:00:00Z', whatsapp_followup_consent_version:'v1', whatsapp:'+5492213032019',language:'es', name:'Gustavo'};
const templates={es:{approved:true,name:'bienvenida_padbol',locale:'es'},en:{approved:true,name:'padbol_welcome',locale:'en_US'}};
const base={sourceId:'request-1',contact,templates,enabled:true};
test('sends only with consent, a valid phone, known language and approved template',()=>{
 assert.equal(prepareWelcome(base).eligible,true);
 for(const [changes,reason] of [[{whatsapp_followup_consent:false},'missing_consent'],[{whatsapp_followup_consent_revoked_at:'today'},'missing_consent'],[{whatsapp:'123'},'invalid_phone'],[{language:'ro'},'language_unknown'],[{name:''},'missing_name']]) assert.equal(prepareWelcome({...base,contact:{...contact,...changes}}).reason,reason);
 assert.equal(prepareWelcome({...base,templates:{}}).reason,'template_not_approved');
 assert.equal(prepareWelcome({...base,enabled:false}).reason,'disabled');
 assert.equal(prepareWelcome({...base,contact:{...contact,language:'en'}}).template.name,'padbol_welcome');
});
test('concurrent events reserve one message and record acceptance',async()=>{
 let claimed=false,sent=0,accepted=0;
 const repository={readAuthoritativeContact:async()=>contact,claimOnce:async()=>{if(claimed)return {acquired:false};claimed=true;return {acquired:true,id:1}},consentStillValid:async()=>true,recordAccepted:async()=>accepted++,recordUnknown:async()=>{},recordSuppressed:async()=>{}};
 const transport={sendApprovedTemplate:async()=>{sent++;return {messageId:'wamid.test'}}};
 const results=await Promise.all(Array.from({length:10},()=>sendWelcomeCandidate({sourceId:'request-1',enabled:true,templates,repository,transport})));
 assert.equal(sent,1);assert.equal(accepted,1);assert.equal(results.filter(r=>r.status==='accepted').length,1);
});
test('revocation before send suppresses delivery; timeout never triggers retry',async()=>{
 let sent=0,claimed=false,unknown=0,suppressed=0;
 const repository={readAuthoritativeContact:async()=>contact,claimOnce:async()=>{if(claimed)return {acquired:false};claimed=true;return {acquired:true,id:1}},consentStillValid:async()=>false,recordSuppressed:async()=>suppressed++,recordUnknown:async()=>unknown++,recordAccepted:async()=>{}};
 const transport={sendApprovedTemplate:async()=>{sent++;throw Error('timeout')}};
 const args={sourceId:'request-1',enabled:true,templates,repository,transport};
 assert.equal((await sendWelcomeCandidate(args)).status,'suppressed');assert.equal(sent,0);assert.equal(suppressed,1);
 claimed=false;repository.consentStillValid=async()=>true;
 assert.equal((await sendWelcomeCandidate(args)).status,'unknown');assert.equal((await sendWelcomeCandidate(args)).status,'already_claimed');assert.equal(sent,1);assert.equal(unknown,1);
});
test('contact consent remains bound to number captured on original form',async()=>{
 const {contactFromCrmConversation}=await import('./crmWelcomeTemplateCandidate.js');
 const c=contactFromCrmConversation({contact:{nombre:'Gus',phone_normalized:'+19999999999'},qualification_data:{whatsapp_contact_consent:{accepted:true,purpose:'consultation_followup',phone:'+5492213032019',language:'es',acceptedAt:'2026-10-22',version:'contacto-whatsapp-consulta-v1'}}});
 assert.equal(c.whatsapp,'+5492213032019');assert.equal(c.whatsapp_followup_consent,true);
});
