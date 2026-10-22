import test from 'node:test';
import assert from 'node:assert/strict';
import { isWhatsappQaMenuEnabled } from './whatsappQaMenuGate.js';
const valid={BACKEND_RUNTIME_MODE:'staging',STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co',CRM_WHATSAPP_LANGUAGE_MENU_ENABLED:'true',WHATSAPP_MENU_ATOMIC_QA_ENABLED:'true',WHATSAPP_QA_MENU_AUTOMATION_ENABLED:'true'};
const dependencies={atomicMenuStore:{},qaRelay:()=>{},sandboxFactory:()=>{},outboundEnabled:true};
test('menu gate fails closed outside exact QA and without every explicit gate',()=>{
 assert.equal(isWhatsappQaMenuEnabled(valid,dependencies),true);
 for(const key of Object.keys(valid)) assert.equal(isWhatsappQaMenuEnabled({...valid,[key]:'wrong'},dependencies),false,key);
 for(const key of Object.keys(dependencies)) assert.equal(isWhatsappQaMenuEnabled(valid,{...dependencies,[key]:null}),false,key);
 assert.equal(isWhatsappQaMenuEnabled({...valid,BACKEND_RUNTIME_MODE:'production'},dependencies),false);
});

test('scoped QA menu can run with global outbound disabled only when explicitly enabled',()=>{
 const scoped={...valid,OUTBOUND_DELIVERY_ENABLED:'false',WHATSAPP_QA_SCOPED_SEND_ENABLED:'true'};
 assert.equal(isWhatsappQaMenuEnabled(scoped,{...dependencies,outboundEnabled:false}),true);
 assert.equal(isWhatsappQaMenuEnabled({...scoped,WHATSAPP_QA_SCOPED_SEND_ENABLED:'false'},{...dependencies,outboundEnabled:false}),false);
 assert.equal(isWhatsappQaMenuEnabled({...scoped,BACKEND_RUNTIME_MODE:'production'},{...dependencies,outboundEnabled:false}),false);
});
