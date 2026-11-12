import test from 'node:test';import assert from 'node:assert/strict';import {registerNationsActivationRoutes} from './nationsActivation.js';
import {createNationsProfileRequestsService} from '../lib/nationsProfileRequests.js';
import {selectionIdFor} from '../lib/nationsSelector.js';
function fixture(user={id:'verified',email_confirmed_at:'yes'},profileRequestsDep=null,fichaReadinessDep=null,enrollmentReadinessDep=null){const routes=new Map(),calls=[];const service=new Proxy({},{get:(_t,name)=>async(...args)=>{calls.push({name,args});return {ok:true};}});registerNationsActivationRoutes({get:(p,f)=>routes.set('GET '+p,f),post:(p,f)=>routes.set('POST '+p,f)},{service,authUserFromBearer:async()=>user,profileRequestsDep,fichaReadinessDep,enrollmentReadinessDep,logger:{error(){}}});return {calls,async call(method,path,body={},slug='nations-test'){const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};await routes.get(method+' '+path)({params:{slug,participantId:'participant'},body,ip:'isolated'},res);return res;}};}
const path='/api/nations-activation/events/:slug/claim',admin='/api/admin/nations-activation/events/:slug/imports/confirm';
test('protected claim and import require verified account',async()=>{for(const user of [null,{id:'unconfirmed'}]){const f=fixture(user);assert.equal((await f.call('POST',path,{code:'x'})).statusCode,401);assert.equal((await f.call('POST',admin,{actor_id:'forged'})).statusCode,401);assert.equal(f.calls.length,0);}});
test('verified actor always comes from auth; rate limit prevents abuse',async()=>{const f=fixture();await f.call('POST',path,{code:'x',actor_id:'forged'});assert.equal(f.calls[0].args[1].id,'verified');for(let i=0;i<9;i++)await f.call('POST',path);assert.equal((await f.call('POST',path)).statusCode,429);assert.equal(f.calls.length,10);});
test('public metadata does not require login',async()=>{const f=fixture(null);assert.equal((await f.call('GET','/api/nations-activation/events/:slug')).statusCode,200);assert.equal(f.calls[0].name,'publicEvent');});


test('profile-request mantiene el límite existente de 10 por minuto por IP',async()=>{
 const calls=[];
 const dep={async submit(){calls.push('submit');return {ok:true,status:'pendiente'};}};
 const f=fixture(undefined,dep);
 const path='/api/nations-activation/events/:slug/profile-request';
 for(let i=0;i<10;i+=1)assert.equal((await f.call('POST',path,{request_id:`req-${i}`})).statusCode,200);
 assert.equal((await f.call('POST',path,{request_id:'req-10'})).statusCode,429);
 assert.equal(calls.length,10);
});

test('selector y reporte exigen cuenta verificada y no exponen datos de cuenta', async () => {
  const routes = new Map();
  const seen = [];
  const selectorDep = {
    async list(slug, actor) { seen.push({kind: 'list', slug, actor}); return {ok: true, participants: [{selectionId: 'a'.repeat(32), name: 'Adult Player', country: 'IT'}]}; },
    async report(slug, actor, selectionId) { seen.push({kind: 'report', slug, actor, selectionId}); return {ok: true, reported: true}; },
  };
  registerNationsActivationRoutes({get: (p, f) => routes.set(`GET ${p}`, f), post: (p, f) => routes.set(`POST ${p}`, f)}, {
    service: new Proxy({}, {get: () => async () => ({ok: true})}),
    selectorDep,
    authUserFromBearer: async (req) => String(req.headers?.authorization || '') === 'Bearer verified'
      ? {id: 'verified', email_confirmed_at: 'yes'} : null,
    logger: {error() {}},
  });
  const call = async (route, body = {}, token = 'verified') => {
    const res = {statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; }};
    await routes.get(route)({params: {slug: 'nations-cup-napoli-2026'}, body, headers: token ? {authorization: `Bearer ${token}`} : {}, ip: 'fixture'}, res);
    return res;
  };
  const list = await call('GET /api/nations-activation/events/:slug/selector');
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.participants, [{selectionId: 'a'.repeat(32), name: 'Adult Player', country: 'IT'}]);
  assert.equal(JSON.stringify(list.body).includes('email'), false);
  assert.equal((await call('GET /api/nations-activation/events/:slug/selector', {}, '')).statusCode, 200);
  const report = await call('POST /api/nations-activation/events/:slug/selector/report', {selection_id: 'a'.repeat(32)});
  assert.equal(report.statusCode, 200);
  assert.deepEqual(report.body, {ok: true, reported: true});
  assert.equal(seen.length, 3);
});


test('Nápoles exige ficha completa antes de profile-request y expone readiness sin PII', async () => {
  let ready = {complete: false, missing: ['ciudad', 'fecha_nacimiento']};
  const calls = [];
  const dep = {async submit(){calls.push('submit');return {ok:true,status:'pendiente'};}};
  const f = fixture(undefined, dep, async () => ready);
  const path = '/api/nations-activation/events/:slug/profile-request';
  const r1 = await f.call('POST', path, {request_id:'req-incomplete'}, 'nations-cup-napoli-2026');
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.body.code, 'PLAYER_PROFILE_INCOMPLETE');
  assert.equal(calls.length, 0);
  const readiness = await f.call('GET', '/api/nations-activation/events/:slug/profile-readiness', {}, 'nations-cup-napoli-2026');
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.body, {complete:false, missing:['ciudad','fecha_nacimiento']});
  ready = {complete:true, missing:[]};
  const r2 = await f.call('POST', path, {request_id:'req-complete'}, 'nations-cup-napoli-2026');
  assert.equal(r2.statusCode, 200);
  assert.equal(calls.length, 1);
});

test('Naples GET/POST/status use minimal gate only; other event readiness remains general',async()=>{
 let general=0,minimal=0;const submitted=[];
 const dep={async submit(slug,actor){submitted.push({slug,actor});return{ok:true,status:'pendiente'}},async ownStatus(){return{ok:true,requests:[]}}};
 const f=fixture(undefined,dep,async()=>{general++;return{complete:false,missing:['numero_documento','ciudad']}},async()=>{minimal++;return{complete:true,missing:[]}});
 const base='/api/nations-activation/events/:slug';
 assert.deepEqual((await f.call('GET',base+'/profile-readiness',{},'nations-cup-napoli-2026')).body,{complete:true,missing:[]});
 assert.equal((await f.call('POST',base+'/profile-request',{},'nations-cup-napoli-2026')).statusCode,200);
 assert.deepEqual((await f.call('GET',base+'/profile-request',{},'nations-cup-napoli-2026')).body.profile_readiness,{complete:true,missing:[]});
 assert.equal(minimal,3);assert.equal(general,0);assert.equal(submitted.length,1);
 assert.deepEqual((await f.call('GET',base+'/profile-readiness',{},'other-event')).body,{complete:false,missing:['numero_documento','ciudad']});assert.equal(general,1);
});

test('minimal gate keeps actual request auth, consent, canonical selection, pending age and idempotency',async()=>{
 const selected='11111111-1111-4111-8111-111111111111',actor={id:'00000000-0000-4000-8000-0000000000cc',email_confirmed_at:'2026-01-01'};
 const sqlCalls=[];let stored=null;
 const query=async(sql,args=[])=>{sqlCalls.push(sql);
  if(sql.includes('from public.nations_activation_events'))return{rows:[{torneo_id:57,enabled:true}]};
  if(sql.includes('from public.torneo_participantes p'))return{rows:[{id:selected,name:'Canonical Player',country:'IT',age_status:'desconocido'}]};
  if(sql.includes('where actor_user_id=$1'))return{rows:stored?[stored]:[]};
  if(sql.includes('insert into public.nations_profile_requests')){stored={id:'request',payload_hash:args[8],payload_hash_version:2,status:'pendiente',selection_status:args[10],age_status:args[5]};return{rows:[]};}
  if(sql.includes('count(*)::int n'))return{rows:[{n:1}]};
  return{rows:[]};
 };
 const requests=createNationsProfileRequestsService({pool:{query,connect:async()=>({query,release(){}})}});
 const ready=async()=>({complete:true,missing:[]});const f=fixture(actor,requests,async()=>{throw Error('general gate must not run')},ready);
 const path='/api/nations-activation/events/:slug/profile-request',slug='nations-cup-napoli-2026';
 const body={request_id:'minimal-req-0001',selection_id:selectionIdFor(57,selected),profile_consent:true,guardian_consent:false,declared_name:'Forged Name',declared_country:'AR',age_status:'adulto'};
 assert.equal((await f.call('POST',path,{...body,profile_consent:false},slug)).body.code,'CONSENT_REQUIRED');
 assert.equal((await f.call('POST',path,{...body,selection_id:'bad'},slug)).body.code,'INVALID_SELECTION');
 assert.equal((await f.call('POST',path,body,slug)).statusCode,200);assert.equal(stored.age_status,'desconocido');assert.equal(stored.selection_status,'verificacion_pendiente');
 assert.equal((await f.call('POST',path,body,slug)).statusCode,200);assert.equal(sqlCalls.filter(s=>s.includes('insert into public.nations_profile_requests')).length,1);
 assert.equal(sqlCalls.some(s=>/update public\.(torneo_participantes|nations_activation_participants)/i.test(s)),false,'request never claims roster identity or marks age adult');
 const unauth=fixture({id:actor.id},requests,null,ready);assert.equal((await unauth.call('POST',path,body,slug)).statusCode,401);
});
