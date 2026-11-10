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

function rateFixture({now = () => Date.now()} = {}) {
  const routes = new Map();
  const submissions = [];
  const statusCalls = [];
  const service = new Proxy({}, {get: () => async () => ({ok: true})});
  const profileRequestsDep = {
    async submit(slug, actor, body) {
      submissions.push({slug, actor, body});
      return {ok: true, status: 'pendiente'};
    },
    async ownStatus(slug, actor) {
      statusCalls.push({slug, actor});
      return {ok: true, requests: []};
    },
  };
  registerNationsActivationRoutes({
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
  }, {
    service,
    profileRequestsDep,
    authUserFromBearer: async (req) => {
      const token = String(req.headers?.authorization || '').replace(/^Bearer /, '');
      if (!token) return null;
      if (token === 'unverified') return {id: 'unverified'};
      return {id: token, email_confirmed_at: 'yes'};
    },
    now,
    logger: {error() {}},
  });
  async function invoke(method, path, slug, token, body = {}, headers = {}) {
    const res = {statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }};
    const req = {params: {slug}, body, ip: 'shared-nat-ip', headers: token ? {authorization: `Bearer ${token}`, ...headers} : headers};
    await routes.get(`${method} ${path}`)(req, res);
    return res;
  }
  const path = '/api/nations-activation/events/:slug/profile-request';
  return {
    submissions,
    statusCalls,
    call: (slug, token, body, headers) => invoke('POST', path, slug, token, body, headers),
    get: (slug, token, headers) => invoke('GET', path, slug, token, {}, headers),
  };
}

test('Nápoles: 55 actores verificados bajo una IP pueden enviar; el límite es por actor y agregado por IP', async () => {
  const fixture = rateFixture();
  for (let i = 1; i <= 55; i += 1) {
    const res = await fixture.call('nations-cup-napoli-2026', `actor-${i}`, {request_id: `req-${i}`});
    assert.equal(res.statusCode, 200);
  }
  assert.equal(fixture.submissions.length, 55);
});

test('Nápoles: un actor no puede spamear más de 5 solicitudes por minuto', async () => {
  const fixture = rateFixture();
  for (let i = 0; i < 5; i += 1) assert.equal((await fixture.call('nations-cup-napoli-2026', 'spammer', {request_id: `req-${i}`})).statusCode, 200);
  assert.equal((await fixture.call('nations-cup-napoli-2026', 'spammer', {request_id: 'req-6'})).statusCode, 429);
  assert.equal(fixture.submissions.length, 5);
});

test('Nápoles: anónimos y no verificados reciben 401 y no llegan al servicio', async () => {
  const fixture = rateFixture();
  assert.equal((await fixture.call('nations-cup-napoli-2026', '', {request_id: 'req-anon'})).statusCode, 401);
  assert.equal((await fixture.call('nations-cup-napoli-2026', 'unverified', {request_id: 'req-unverified'})).statusCode, 401);
  assert.equal(fixture.submissions.length, 0);
  assert.equal((await fixture.call('nations-cup-napoli-2026', 'verified-after', {request_id: 'req-ok'})).statusCode, 200);
});

test('otros slugs conservan el límite previo de 10 por minuto por IP', async () => {
  const fixture = rateFixture();
  for (let i = 0; i < 10; i += 1) assert.equal((await fixture.call('otro-evento', `actor-${i}`, {request_id: `req-${i}`})).statusCode, 200);
  assert.equal((await fixture.call('otro-evento', 'actor-x', {request_id: 'req-x'})).statusCode, 429);
});


test('Nápoles: 55 aperturas consultan, envían y vuelven a consultar bajo la misma IP', async () => {
  const fixture = rateFixture();
  for (let i = 1; i <= 55; i += 1) {
    const token = `flow-actor-${i}`;
    assert.equal((await fixture.get('nations-cup-napoli-2026', token)).statusCode, 200);
    assert.equal((await fixture.call('nations-cup-napoli-2026', token, {request_id: `req-flow-${i}`})).statusCode, 200);
    assert.equal((await fixture.get('nations-cup-napoli-2026', token)).statusCode, 200);
  }
  assert.equal(fixture.submissions.length, 55);
  assert.equal(fixture.statusCalls.length, 110);
  assert.ok(fixture.statusCalls.every((call) => call.actor.id.startsWith('flow-actor-')));
});

test('Nápoles: el techo agregado de 120 consultas por IP rechaza la 121', async () => {
  const fixture = rateFixture();
  for (let i = 1; i <= 120; i += 1) {
    assert.equal((await fixture.get('nations-cup-napoli-2026', `get-actor-${i}`)).statusCode, 200);
  }
  assert.equal((await fixture.get('nations-cup-napoli-2026', 'get-actor-121')).statusCode, 429);
  assert.equal(fixture.statusCalls.length, 120);
});

test('Nápoles: la ventana de un minuto se resetea', async () => {
  let clock = 1_000_000;
  const fixture = rateFixture({now: () => clock});
  for (let i = 0; i < 5; i += 1) assert.equal((await fixture.call('nations-cup-napoli-2026', 'window-actor', {request_id: `req-w-${i}`})).statusCode, 200);
  assert.equal((await fixture.call('nations-cup-napoli-2026', 'window-actor', {request_id: 'req-w-6'})).statusCode, 429);
  clock += 60_001;
  assert.equal((await fixture.call('nations-cup-napoli-2026', 'window-actor', {request_id: 'req-w-7'})).statusCode, 200);
});

test('Nápoles: consulta anónima recibe 401 y no llama a ownStatus', async () => {
  const fixture = rateFixture();
  assert.equal((await fixture.get('nations-cup-napoli-2026', '')).statusCode, 401);
  assert.equal(fixture.statusCalls.length, 0);
});

test('otros slugs conservan el límite de 20 consultas por IP', async () => {
  const fixture = rateFixture();
  for (let i = 0; i < 20; i += 1) assert.equal((await fixture.get('otro-evento', `get-other-${i}`)).statusCode, 200);
  assert.equal((await fixture.get('otro-evento', 'get-other-x')).statusCode, 429);
});
