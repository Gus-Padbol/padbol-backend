import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { createWhatsappContextRelay } from './whatsappContextRelay.js';
const secret='test-secret-for-context-relay-123456789';
const env={ WHATSAPP_CONTEXT_QA_RELAY_ENABLED:'true', WHATSAPP_CONTEXT_BINDING_SECRET:secret,
  WHATSAPP_QA_MENU_TEST_RECIPIENT:'15551232019', BACKEND_RUNTIME_MODE:'staging',
  RENDER_SERVICE_ID:'srv-dahbs0dbedkc73a0kf4g', STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',
  SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co', WHATSAPP_QA_MENU_AUTOMATION_ENABLED:'true', WHATSAPP_MENU_ATOMIC_QA_ENABLED:'true' };
const entry=()=>({inbound_message_id:'in-1',lease_token:'lease-1',revision:1,payload:{revision:1,wabaId:'928900479733370',phoneNumberId:'1376102838911694',messageId:'wamid.test',sender:'15551232019',context:{stage:'topic'}}});
function harness(fetchImpl,item=entry()){const finish=[]; const relay=createWhatsappContextRelay({env,fetchImpl,now:()=>1700000000000,
  repository:{async claim(){return item},async finish(args){finish.push(args);return true}}});return {relay,finish};}
function signedResponse(body,request,overrides={}, status=200) {const bytes=Buffer.from(JSON.stringify(body)); const hash=createHash('sha256').update(request.body).digest('hex');
 const sig=createHmac('sha256',secret).update('padbol-qa-context-response-v1\n').update(hash).update('\n').update(bytes).digest('hex');
 return new Response(bytes,{status,headers:{'x-padbol-response-signature':sig,...overrides}});}
test('QA env exact and explicit opt-in are required',()=>{
 assert.equal(createWhatsappContextRelay({env:{}}),null);
 for(const change of [{BACKEND_RUNTIME_MODE:'production'},{WHATSAPP_CONTEXT_BINDING_SECRET:'short'},{WHATSAPP_QA_MENU_TEST_RECIPIENT:'bad'}])
   assert.throws(()=>createWhatsappContextRelay({env:{...env,...change},repository:{claim(){},finish(){}}}));
});
test('correct request signature and signed response complete one leased event',async()=>{
 const h=harness(async (url,request)=>{assert.equal(url,'https://padbol-backend.onrender.com/api/internal/whatsapp-context');
  const sig=createHmac('sha256',secret).update('padbol-qa-context-v1\n').update(request.headers['x-padbol-timestamp']).update('\n').update(request.body).digest('hex');
  assert.equal(request.headers['x-padbol-signature'],sig);
  return signedResponse({ticket_reference:'PB-'+'A'.repeat(32),replay:false},request);});
 assert.equal((await h.relay.processOne()).status,'sent');assert.equal(h.finish[0].ticket,'PB-'+'A'.repeat(32));
});
test('untrusted signature, unauthorized recipient, transport failure and invalid reference retry without ticket',async()=>{
 for (const mode of ['signature','recipient','network','reference']) {
  const item=entry();if(mode==='recipient')item.payload.sender='15559999999';
  const h=harness(async (_url,request)=>{if(mode==='network')throw Error('offline');
    if(mode==='signature')return signedResponse({ticket_reference:'PB-'+'A'.repeat(32),replay:false},request,{'x-padbol-response-signature':'0'.repeat(64)});
    return signedResponse({ticket_reference:'BAD',replay:false},request);},item);
  assert.equal((await h.relay.processOne()).status,'retry');assert.equal(h.finish[0].ticket,null);
 }
});
test('event not yet confirmed is retried and conflicting replay is held',async()=>{
 for(const [code,expected] of [['WA_CONTEXT_EVENT_UNCONFIRMED','retry'],['WA_CONTEXT_REPLAY_CONFLICT','conflict']]){
  const h=harness(async(_url,request)=>signedResponse({code},request,{},409));
  assert.equal((await h.relay.processOne()).status,expected);
 }
});

test('unsigned conflict cannot stop retries',async()=>{
 const h=harness(async()=>new Response(JSON.stringify({code:'WA_CONTEXT_REPLAY_CONFLICT'}),{status:409}));
 assert.equal((await h.relay.processOne()).status,'retry');
});
