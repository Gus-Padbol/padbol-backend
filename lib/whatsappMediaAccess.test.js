import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWhatsappMediaAccess, createWhatsappMediaRepository, registerWhatsappMediaAccessRoute } from './whatsappMediaAccess.js';
const bytes = Buffer.from('synthetic-file');
const meta = { id: '123456', url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?opaque=1', file_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const env = { CRM_WHATSAPP_PHONE_NUMBER_ID:'1376102838911694', CRM_WHATSAPP_ACCESS_TOKEN:'synthetic-token', WHATSAPP_META_GRAPH_VERSION:'v26.0' };
const response = (b, extra={}) => ({ ok:true, redirected:false, headers:{get:()=>null}, body: (async function*(){yield Buffer.from(b)})(), ...extra });
function setup({ auth = async()=>{}, ref = {mediaId:'123456'}, data = meta, file = bytes, maxBytes } = {}) {
 const calls=[]; const service = createWhatsappMediaAccess({env, maxBytes, authorizeConversation:auth, repository:{findMediaReference:async()=>ref}, fetchImpl: async (url, opts)=>{calls.push({url,opts}); return calls.length === 1 ? response(JSON.stringify(data)) : response(file)}});
 return {service,calls};
}
const args={user:{id:'operator'},conversationId:'conversation',eventId:'event'};
test('only authorized conversation event gets scoped Meta download without exposing credentials',async()=>{
 const {service,calls}=setup(); const got=await service(args); assert.deepEqual(got.buffer,bytes);assert.equal(got.contentType,'application/octet-stream');assert.equal(calls.length,2);
 assert.equal(calls[0].url.host,'graph.facebook.com');assert.equal(calls[0].url.searchParams.get('phone_number_id'),env.CRM_WHATSAPP_PHONE_NUMBER_ID);
 assert.equal(calls[1].url.host,'lookaside.fbsbx.com');assert(calls.every(c=>c.opts.redirect==='error' && c.opts.method==='GET'));
 assert.equal(JSON.stringify({contentType:got.contentType,filename:got.filename}).includes(env.CRM_WHATSAPP_ACCESS_TOKEN),false);
});
test('reject unauthorized requests before looking up data or calling Meta',async()=>{
 let lookup=0, calls=0;const service=createWhatsappMediaAccess({env,authorizeConversation:async()=>{throw Error('denied')},repository:{findMediaReference:async()=>{lookup++}},fetchImpl:async()=>{calls++}});
 await assert.rejects(()=>service(args));assert.equal(lookup,0);assert.equal(calls,0);
});
test('rejects untrusted URL and prevents token disclosure to other hosts',async()=>{
 for (const url of ['https://example.com/whatsapp_business/file','http://lookaside.fbsbx.com/whatsapp_business/file','https://lookaside.fbsbx.com.evil.com/whatsapp_business/file','https://lookaside.fbsbx.com/not-allowed']) {
  const {service,calls}=setup({data:{...meta,url}});await assert.rejects(()=>service(args),e=>e.code==='WHATSAPP_MEDIA_URL_INVALID');assert.equal(calls.length,1);
 }
});
test('rejects invalid IDs, huge files, redirect and tampering',async()=>{
 let h=setup({ref:{mediaId:'../../x'}});await assert.rejects(()=>h.service(args));assert.equal(h.calls.length,0);
 h=setup({data:{...meta,file_size:500},maxBytes:32});await assert.rejects(()=>h.service(args),e=>e.code==='WHATSAPP_MEDIA_TOO_LARGE');assert.equal(h.calls.length,1);
 h=setup({file:Buffer.from('synthetic-filf')});await assert.rejects(()=>h.service(args),e=>e.code==='WHATSAPP_MEDIA_INTEGRITY_FAILED');
});

test('reference lookup binds event to conversation, WhatsApp origin and configured channel',async()=>{
 const queries=[];const db={from(table){const conditions=[];queries.push({table,conditions});return {select(){return this},eq(k,v){conditions.push([k,v]);return this},async maybeSingle(){return {data:table==='crm_inbound_events'?{source_ref:'wamid'}:{meta_media_id:'123456',meta_media_type:'image'}}}}}};
 const repository=createWhatsappMediaRepository({supabaseAdmin:db,channelId:'11111111-1111-4111-8111-111111111111',phoneNumberId:'1376102838911694'});
 assert.deepEqual(await repository.findMediaReference({conversationId:'conv',eventId:'event'}),{mediaId:'123456',mediaType:'image'});
 assert.deepEqual(queries[0].conditions,[['id','event'],['conversation_id','conv'],['source_channel','whatsapp'],['origin','whatsapp:1376102838911694']]);
 assert.deepEqual(queries[1].conditions,[['channel_id','11111111-1111-4111-8111-111111111111'],['provider_message_id','wamid']]);
});

test('private route rejects unauthenticated and unauthorized access without querying or fetching',async()=>{
 let route,queries=0,network=0; const app={get:(path,fn)=>{if(path.endsWith('/events/:eventId/whatsapp-media'))route=fn}};
 const fakeDb={from(){queries++;throw Error('must not query')}};
 let user=null;registerWhatsappMediaAccessRoute(app,{crmAdminService:{getInbox:async()=>{throw Object.assign(Error('denied'),{status:403})}},supabaseAdmin:fakeDb,authUserFromBearer:async()=>user,fetchUserRoleRow:async()=>({role:'reader'}),env,fetchImpl:async()=>{network++}});
 const res={headers:{},set(k,v){this.headers[k]=v;return this},status(n){this.code=n;return this},json(o){this.data=o;return this}};
 const req={params:{conversationId:'conv',eventId:'event'}};await route(req,res);assert.equal(res.code,401);user={id:'user',email:'user@example.test'};await route(req,res);assert.equal(res.code,403);assert.equal(queries,0);assert.equal(network,0);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('list returns event IDs and types, never Meta IDs',async()=>{
 const observed=[]; const db={from(table){const q={select(){return q},eq(k,v){observed.push([table,k,v]);return q},order(){return q},limit(){return Promise.resolve({data:[{id:'event-id',source_ref:'wamid.secret'}]})},in(k,values){observed.push([table,k,values]);return Promise.resolve({data:[{provider_message_id:'wamid.secret',meta_media_type:'image'}]})}};return q}};
 const repo=createWhatsappMediaRepository({supabaseAdmin:db,channelId:'11111111-1111-4111-8111-111111111111',phoneNumberId:'1376102838911694'});
 const result=await repo.listMediaReferences({conversationId:'conv'}); assert.deepEqual(result,[{eventId:'event-id',mediaType:'image'}]);assert(!JSON.stringify(result).includes('wamid'));
 assert(observed.some(item=>item[1]==='conversation_id'&&item[2]==='conv'));assert(observed.some(item=>item[1]==='channel_id'&&item[2]==='11111111-1111-4111-8111-111111111111'));
});
test('media listing authorizes conversation and exposes only local event ids',async()=>{
 let route; const app={get:(path,fn)=>{if(path==='/api/admin/crm/conversations/:conversationId/whatsapp-media')route=fn}};
 let authorized=false; const db={from(table){assert(authorized);const q={select(){return q},eq(){return q},order(){return q},limit(){return Promise.resolve({data:[{id:'event-id',source_ref:'wamid.priv'}]})},in(){return Promise.resolve({data:[{provider_message_id:'wamid.priv',meta_media_type:'image'}]})}};return q}};
 const res={set(){return this},status(n){this.code=n;return this},json(x){this.data=x;return this}};
 registerWhatsappMediaAccessRoute(app,{crmAdminService:{getInbox:async x=>{assert.equal(x.id,'conv');authorized=true}},supabaseAdmin:db,authUserFromBearer:async()=>({id:'user',email:'person@example.test'}),fetchUserRoleRow:async()=>({role:'admin'}),env:{...env,CRM_WHATSAPP_CHANNEL_ID:'11111111-1111-4111-8111-111111111111'}});
 await route({params:{conversationId:'conv'}},res);assert.deepEqual(res.data,{attachments:[{eventId:'event-id',mediaType:'image'}]});assert.equal(JSON.stringify(res.data).includes('wamid'),false);
});
