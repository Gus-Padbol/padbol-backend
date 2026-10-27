import test from 'node:test';
import assert from 'node:assert/strict';
import {formSubmissionToCrmIngest} from './crmInboundForm.js';
import {WELCOME_CONSENT_TEXT,WELCOME_CONSENT_VERSION} from './crmWelcomeConsentCandidate.js';
const fields={consentFormType:'contact:Quiero comprar una cancha',consentWhatsapp:true,whatsappConsentVersion:WELCOME_CONSENT_VERSION,whatsappConsentText:WELCOME_CONSENT_TEXT.es,whatsappConsentLanguage:'es',whatsappConsentSource:'attacker',whatsappConsentAcceptedAt:'1990-01-01'};
const form={id:'persisted-id',form:'Consulta Padbol · Quiero una cancha',email:'example@example.test',phone:'+5492213032019',name:'Test',workflow:'commercial_lead',fields};
test('commercial inbound carries validated consent in persisted qualification data, with server time',()=>{
 const before=Date.now();const event=formSubmissionToCrmIngest(form);const c=event.qualificationData.whatsapp_contact_consent;
 assert.equal(c.accepted,true);assert.equal(c.source,'web:contacto');assert.ok(Date.parse(c.acceptedAt)>=before);assert.equal(c.purpose,'consultation_followup');
});
test('unchecked, unverified text and noncommercial form never give consent',()=>{
 for(const changes of [{consentWhatsapp:false},{whatsappConsentText:'other'},{consentFormType:'academy'}]) assert.equal(formSubmissionToCrmIngest({...form,fields:{...fields,...changes}}).qualificationData.whatsapp_contact_consent.accepted,false);
 assert.equal(formSubmissionToCrmIngest({...form,workflow:'program_registration'}).qualificationData.whatsapp_contact_consent.accepted,false);
});

test('CRM stores original consent once and duplicate event cannot replace it',async()=>{
 const {createCrmService}=await import('./crmService.js');
 let savedContact=null,savedAttempt=null,savedConversation=null,savedEvent=null;
 const repo={
  findContactsByEmailOrPhone:async()=>savedContact?[savedContact]:[],
  createContact:async p=>(savedContact={id:'contact',...p}),
  findAttempt:async()=>savedAttempt,
  createAttempt:async p=>(savedAttempt={id:'attempt',...p}),
  findConversation:async()=>savedConversation,
  createConversation:async p=>(savedConversation={id:'conversation',...structuredClone(p)}),
  findInboundEvent:async()=>savedEvent,
  createInboundEvent:async p=>(savedEvent={id:'event',...p}),
  getConversation:async()=>savedConversation,
 };
 const service=createCrmService({repository:repo});
 const first=await service.ingestInbound(formSubmissionToCrmIngest(form));
 const retry=await service.ingestInbound(formSubmissionToCrmIngest({...form,fields:{...fields,consentWhatsapp:false}}));
 assert.equal(first.status,'accepted');assert.equal(retry.status,'idempotent');
 assert.equal(savedConversation.qualification_data.whatsapp_contact_consent.accepted,true);
});
