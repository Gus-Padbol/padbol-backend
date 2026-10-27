import test from 'node:test';
import assert from 'node:assert/strict';
import {productionMenuTokenResolver} from './whatsappProductionTokenCandidate.js';
const env = { BACKEND_RUNTIME_MODE:'production', CRM_WHATSAPP_PHONE_NUMBER_ID:'1376102838911694',
  CRM_WHATSAPP_WABA_ID:'928900479733370', CRM_WHATSAPP_CHANNEL_ID:'1bad838f-b5cc-4ae4-b28d-e63c998c6474',
  CRM_WHATSAPP_ACCESS_TOKEN:'synthetic-token' };
const channel = { id:env.CRM_WHATSAPP_CHANNEL_ID, meta_phone_number_id:env.CRM_WHATSAPP_PHONE_NUMBER_ID, credential_ref:'PRODUCTION' };
test('only the verified production channel may use the CRM credential',()=>{
  assert.equal(productionMenuTokenResolver(env)(channel),'synthetic-token');
  for (const invalid of [{...channel,id:'other'}, {...channel,meta_phone_number_id:'12345'}, {...channel,credential_ref:'TEST'}, null])
    assert.equal(productionMenuTokenResolver(env)(invalid),null);
  for (const invalid of [{...env,BACKEND_RUNTIME_MODE:'staging'}, {...env,CRM_WHATSAPP_WABA_ID:'wrong'},
    {...env,CRM_WHATSAPP_CHANNEL_ID:'other'}, {...env,CRM_WHATSAPP_ACCESS_TOKEN:''}])
    assert.equal(productionMenuTokenResolver(invalid)(channel),null);
});
