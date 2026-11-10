import test from 'node:test';import assert from 'node:assert/strict';import {registerNationsActivationRoutes} from './nationsActivation.js';
function fixture(user={id:'verified',email_confirmed_at:'yes'},profileRequestsDep=null){const routes=new Map(),calls=[];const service=new Proxy({},{get:(_t,name)=>async(...args)=>{calls.push({name,args});return {ok:true};}});registerNationsActivationRoutes({get:(p,f)=>routes.set('GET '+p,f),post:(p,f)=>routes.set('POST '+p,f)},{service,authUserFromBearer:async()=>user,profileRequestsDep,logger:{error(){}}});return {calls,async call(method,path,body={}){const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};await routes.get(method+' '+path)({params:{slug:'nations-test',participantId:'participant'},body,ip:'isolated'},res);return res;}};}
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
