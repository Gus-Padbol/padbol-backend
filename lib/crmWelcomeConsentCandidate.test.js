import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWelcomeConsent, WELCOME_CONSENT_TEXT, WELCOME_CONSENT_VERSION} from './crmWelcomeConsentCandidate.js';
const clock=()=>new Date('2026-10-22T12:00:00Z');
const input={consentWhatsapp:true,whatsappConsentLanguage:'es',whatsappConsentText:WELCOME_CONSENT_TEXT.es,whatsappConsentVersion:WELCOME_CONSENT_VERSION,whatsappConsentAcceptedAt:'1990-01-01',whatsappConsentSource:'client-forgery'};
test('the server records explicit consent with a server time and trusted source',()=>{
 const result=buildWelcomeConsent(input,{source:'web:contacto',now:clock});
 assert.equal(result.acceptedAt,'2026-10-22T12:00:00.000Z');assert.equal(result.source,'web:contacto');assert.equal(result.purpose,'consultation_followup');
 assert.equal(buildWelcomeConsent({...input,consentWhatsapp:false},{source:'web:contacto'}).accepted,false);
});
test('only the exact shown language and version are valid',()=>{
 for(const change of [{whatsappConsentVersion:'v0'},{whatsappConsentText:'different'},{whatsappConsentLanguage:'fr'}]) assert.equal(buildWelcomeConsent({...input,...change},{source:'web:contacto'}).accepted,false);
 const english=buildWelcomeConsent({...input,whatsappConsentLanguage:'en',whatsappConsentText:WELCOME_CONSENT_TEXT.en},{source:'web:contacto',now:clock});assert.equal(english.accepted,true);assert.equal(english.language,'en');
 assert.throws(()=>buildWelcomeConsent(input,{source:'untrusted'}));
});
