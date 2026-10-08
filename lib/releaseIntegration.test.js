import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseScopeResolver, mountReleaseRoutes } from './releaseServices.js';
import { resolveStoredRoleForVerifiedUser } from './roleIdentity.js';
import { createLegacyPushBridge, mountLegacyPushBridgeRoute, normalizeLegacyPushData } from './legacyPushBridge.js';
import { configureMobilePushBridge, sendPushToUser } from '../utils/push.js';
import { PUSH_LANGUAGES, localizedPushPreview } from './pushLanguages.js';

function database(seed = {}) {
  const tables = structuredClone(seed), calls = [];
  return { tables, calls, from(table) {
    const filters = []; let patch, insert;
    const q = {
      select() { return q; }, eq(k,v) { filters.push(r=>r[k]===v); return q; },
      not(k,op,v) { filters.push(r=>r[k]!==v); return q; },
      is(k,v) { filters.push(r=>(r[k]??null)===v); return q; },
      in(k,v) { filters.push(r=>v.includes(r[k])); return q; },
      order() { return q; }, limit() { return q; },
      update(value) { patch=value; return q; },
      insert(value) { insert=value; return q; },
      then(resolve,reject) { return Promise.resolve(q.run(false)).then(resolve,reject); },
      maybeSingle() { return Promise.resolve(q.run(true)); },
      single() { return Promise.resolve(q.run(true)); },
      run(single) {
        calls.push({table, patch, insert});
        tables[table] ||= [];
        if (insert) tables[table].push({ id: tables[table].length+1, ...insert });
        const rows=tables[table].filter(r=>filters.every(fn=>fn(r)));
        if(patch) rows.forEach(r=>Object.assign(r,patch));
        return {data:single?rows[0]||null:rows,error:null};
      },
    };return q;
  } };
}

function appFixture() {
  const routes=new Map(); const app={routes, use(){}};
  for(const method of ['get','post','patch','put','delete']) app[method]=(url,...handlers)=>routes.set(`${method} ${url}`,handlers.at(-1));
  return app;
}
function response() { return { statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;},send(data){this.data=data;return this;}}; }
const USER = {id:'user-a',email:'assigned@example.invalid',email_confirmed_at:'2026-09-09T00:00:00Z'};

test('an assigned role is bound only to the confirmed authenticated owner, without changing geography', async () => {
  const db=database({user_roles:[{email:USER.email,user_id:null,role:'admin_nacional',alcance:'ciudad',pais:'Argentina',provincia:'Córdoba',ciudad:'San Martín'}]});
  const row=await resolveStoredRoleForVerifiedUser(db,USER);
  assert.equal(row.user_id,USER.id);assert.equal(row.provincia,'Córdoba');
  assert.deepEqual(db.calls.find(c=>c.patch).patch,{user_id:USER.id});
  assert.equal(await resolveStoredRoleForVerifiedUser(db,{...USER,id:'other-user'}),null);
});

test('unconfirmed email cannot claim a pending role and lookup errors fail closed', async () => {
  const db=database({user_roles:[{email:USER.email,user_id:null,role:'super_admin'}]});
  assert.equal(await resolveStoredRoleForVerifiedUser(db,{...USER,email_confirmed_at:null}),null);
  assert.equal(db.calls.some(c=>c.patch),false);
  const offline={from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {error:{code:'offline'}};}};}};
  await assert.rejects(resolveStoredRoleForVerifiedUser(offline,USER),{status:503});
});

test('role scope preserves parents and rejects a forged global scope on a national role', async () => {
  const db=database({user_roles:[{user_id:USER.id,role:'admin_nacional',alcance:'ciudad',pais:'Argentina',provincia:'Córdoba',ciudad:'San Martín'}]});
  const resolve=createReleaseScopeResolver({supabaseAdmin:db,getAuthenticatedUser:async()=>({user:USER})});
  assert.equal((await resolve({})).provinciaNorm,'cordoba');
  db.tables.user_roles[0].alcance='global';
  const scope=await resolve({});assert.equal(scope.alcance,'none');assert.equal(scope.superA,false);
});

test('legacy push helpers retain their positional API and dispatch through the secure registry', async () => {
  const calls=[];configureMobilePushBridge({send:async value=>{calls.push(value);return {ok:true};}});
  try { await sendPushToUser({},USER.id,{title:'Update',body:'Details',data:{type:'general'}});
    assert.deepEqual(calls[0].userIds,[USER.id]);assert.equal(calls[0].title,'Update');
  } finally {configureMobilePushBridge(null);}
});

test('disabled delivery never reads tokens or calls a provider', async () => {
  const bridge=createLegacyPushBridge({runtime:{pushSendEnabled:false},supabaseAdmin:{from(){throw Error('unexpected database access');}},pushService:{dispatch(){throw Error('unexpected send');}}});
  assert.equal((await bridge.send({tokens:['ExpoPushToken[test]']})).disabled,true);
});

test('legacy explicit token targeting never expands to all installations of its owner', async () => {
  const db=database({push_tokens:[{id:1,user_id:USER.id,expo_push_token:'ExpoPushToken[one]',enabled:true},{id:2,user_id:USER.id,expo_push_token:'ExpoPushToken[two]',enabled:true}]});
  let sent;const bridge=createLegacyPushBridge({supabaseAdmin:db,runtime:{pushSendEnabled:true},pushService:{async dispatch(args){sent=args;return {};}}});
  await bridge.send({tokens:['ExpoPushToken[one]'],title:'Update',body:'Details'});
  assert.deepEqual(sent.tokenIds,[1]);assert.deepEqual(sent.userIds,[USER.id]);
});

test('legacy free text HTTP is marketing and its idempotency key is namespaced to the actor', async () => {
  const app=appFixture();let sent;
  mountLegacyPushBridgeRoute(app,{bridge:{owners:async()=>[{user_id:USER.id}],send:async args=>{sent=args;return {}; }},
    adminListScopeFromRequest:async()=>({rol:'super_admin',superA:true,authUserId:'admin-a'}),
    sedesPermitidasPorScope:async()=>({sedes:[]}),supabaseAdmin:database({jugadores_perfil:[{user_id:USER.id,email:USER.email}]})});
  const res=response();await app.routes.get('post /api/push/send')({headers:{},body:{tokens:['ExpoPushToken[one]'],title:'Free text',body:'Message',category:'transactional',idempotencyKey:'same'}},res);
  assert.equal(res.statusCode,200);assert.equal(sent.category,'marketing');assert.equal(sent.idempotencyKey,'legacy_http:admin-a:same');
});

test('all twenty installation languages receive the generic transactional preview; free text remains literal', () => {
  for(const language of PUSH_LANGUAGES){const input={language,type:'general',title:'Personal name',body:'Private detail'};
    const preview=localizedPushPreview({...input,category:'transactional'});
    assert.equal(preview.title,'Padbol Match');assert.notEqual(preview.body,input.body);
    assert.deepEqual(localizedPushPreview({...input,category:'marketing'}),{title:input.title,body:input.body});
  }
  assert.deepEqual(normalizeLegacyPushData({type:'unknown',password:'secret'}),{type:'general',route:'Notificaciones',params:{}});
});

test('release mounts alongside the current runtime and territorial assignments reject missing parents before writes', async () => {
  const db=database({user_roles:[{user_id:USER.id,role:'super_admin',alcance:'global'}]});
  const app=appFixture();mountReleaseRoutes(app,{supabaseAdmin:db,getAuthenticatedUser:async()=>({user:USER}),serviceRoleConfigured:true,
    runtime:{mode:'staging',outboundDeliveryEnabled:false,pushSendEnabled:false},cron:{schedule(){}}});
  for(const route of ['get /ready','post /api/admin/roles','get /api/admin/invitaciones-admin','post /api/legal/eliminacion/solicitudes','delete /api/push-tokens']) assert.ok(app.routes.has(route),route);
  const res=response();await app.routes.get('post /api/admin/roles')({body:{email:'target@example.invalid',role:'admin_nacional',alcance:'ciudad',pais:'Argentina',ciudad:'San Martín'}},res);
  assert.equal(res.statusCode,400);assert.equal(db.calls.some(c=>c.insert||c.patch),false);
  configureMobilePushBridge(null);
});

test('paused and deleted chains do not retain venue access through preserved links', async () => {
  const { resolveSedesPermitidasPorScope } = await import('./adminTerritorialScope.js');
  for (const estado of ['activa','pausada','baja']) {
    const db=database({organizaciones:[{id:'org',estado}],organizacion_sedes:[{organizacion_id:'org',sede_id:1}],sedes:[{id:1}]});
    const result=await resolveSedesPermitidasPorScope(db,{rol:'admin_cadena',alcance:'organizacion',organizacionId:'org'});
    assert.deepEqual(result.sedes.map(row=>row.id),estado==='activa'?[1]:[]);
  }
});

test('revoked roles cannot regain superadmin through an email allowlist', async () => {
  const { resolveAuthRoleForUser } = await import('./authAccess.js');
  const role=await resolveAuthRoleForUser(USER,{fetchUserRoleRowForAuthUser:async()=>null,legacySuperAdminEmails:[USER.email]});
  assert.equal(role.rol,null);
});

test('venue inserts map real legacy fields and reject missing configuration without invented defaults', async () => {
  const { buildSedeReleaseInsert } = await import('./sedeReleaseContract.js');
  const payload={nombre:'Test club',pais:'Argentina',ciudad:'Test city',cantidad_canchas:2,horario_apertura:'18:00',horario_cierre:'02:00',precio_turno:100,telefono:'+15550000000'};
  const row=buildSedeReleaseInsert(payload);
  assert.equal(row.precio_por_reserva,100);assert.equal(row.whatsapp_contacto,payload.telefono);
  for(const field of ['horario_apertura','horario_cierre','precio_turno','telefono','cantidad_canchas'])
    assert.throws(()=>buildSedeReleaseInsert({...payload,[field]:null}),{status:400,code:'SEDE_REQUIRED_CONFIGURATION'});
  assert.throws(()=>buildSedeReleaseInsert({...payload,precio_turno:1.5}),{status:400});
  assert.throws(()=>buildSedeReleaseInsert({...payload,horario_apertura:'25:00'}),{status:400});
});

test('staging SQL connection must identify the exact independent project and require TLS', async () => {
  const { assertStagingIsolation } = await import('./backendRuntime.js');
  const env={BACKEND_RUNTIME_MODE:'staging',STAGING_SUPABASE_PROJECT_REF:'stagefixture',PRODUCTION_SUPABASE_PROJECT_REF:'productionfixture',SUPABASE_URL:'https://stagefixture.supabase.co',SUPABASE_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture'};
  for(const DATABASE_URL of ['postgresql://postgres:fake@db.stagefixture.supabase.co:5432/postgres?sslmode=require','postgresql://postgres.stagefixture:fake@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require'])
    assert.doesNotThrow(()=>assertStagingIsolation({...env,DATABASE_URL}));
  for(const DATABASE_URL of ['postgresql://postgres:fake@db.productionfixture.supabase.co/postgres?sslmode=require','postgresql://postgres.productionfixture:fake@aws-1-us-east-2.pooler.supabase.com/postgres?sslmode=require','postgresql://postgres:fake@db.stagefixture.supabase.co/postgres','postgresql://postgres:fake@db.stagefixture.supabase.co/postgres?sslmode=require&host=elsewhere'])
    assert.throws(()=>assertStagingIsolation({...env,DATABASE_URL}));
});

test('disabled staging blocks external HTTP and SDK route handlers before persistence', async () => {
  const { installStagingFetchGuard, externalOperationsGate, backendSqlReadiness } = await import('./backendRuntime.js');
  let sent=0;const target={fetch:async()=>{sent++;return {ok:true};}};
  const restore=installStagingFetchGuard({BACKEND_RUNTIME_MODE:'staging',STAGING_SUPABASE_PROJECT_REF:'stagefixture'},target);
  await target.fetch('https://stagefixture.supabase.co/rest/v1/roles');
  await assert.rejects(target.fetch('https://api.mercadopago.com/checkout/preferences'),{code:'OUTBOUND_DISABLED'});
  assert.equal(sent,1);restore();
  const res=response();let handlerCalls=0;
  externalOperationsGate({outboundDeliveryEnabled:false})({},res,()=>handlerCalls++);
  assert.equal(res.statusCode,503);assert.equal(handlerCalls,0);
  assert.deepEqual(await backendSqlReadiness(null),{ready:false,reason:'sql_not_configured'});
  assert.deepEqual(await backendSqlReadiness({query:async()=>({rows:[{ok:1}]})}),{ready:true});
});

test('public alias availability reveals only a boolean and escapes wildcard input', async () => {
  const { mountAliasAvailabilityRoute } = await import('./publicAliasAvailability.js');
  let filter,rows=[{user_id:USER.id}],error=null;
  const db={from(){return {select(){return this;},ilike(_key,value){filter=value;return this;},async limit(){return {data:rows,error};}};}};
  const app=appFixture();mountAliasAvailabilityRoute(app,{supabaseAdmin:db,authUserFromBearer:async()=>USER});
  const handler=app.routes.get('get /api/registro/alias-disponible');
  let res=response();await handler({query:{alias:'My_Alias%',user_id:USER.id},headers:{}},res);
  assert.deepEqual(res.data,{available:false});assert.equal(filter,'My\\_Alias\\%');
  res=response();await handler({query:{alias:'MyAlias'},headers:{authorization:'Bearer fixture'}},res);
  assert.deepEqual(res.data,{available:true});
  rows.push({user_id:'another'});res=response();await handler({query:{alias:'MyAlias'},headers:{authorization:'Bearer fixture'}},res);
  assert.deepEqual(res.data,{available:false});
  error={code:'offline'};res=response();await handler({query:{alias:'MyAlias'},headers:{}},res);
  assert.equal(res.statusCode,503);assert.equal(Object.hasOwn(res.data,'available'),false);
});

test('club roles without a venue cannot reach an admin handler', async () => {
  const { requireAdminUser } = await import('./authAccess.js');
  for(const sede_id of [null,0,-1]) {
    const res=response();const result=await requireAdminUser({},res,{getAuthenticatedUser:async()=>({user:USER}),fetchUserRoleRowForAuthUser:async()=>({role:'admin_club',sede_id})});
    assert.equal(result,null);assert.equal(res.statusCode,403);
  }
});

test('venue names are a legacy fallback only when unique and the reservation lacks its own venue ID', async () => {
  const { resolveReservasListScope, applyReservasListScopeToQuery } = await import('./authAccess.js');
  let count=1;
  const db={from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{nombre:'Same club'}};},then(resolve){resolve({count,error:null});}};}};
  let scope=await resolveReservasListScope({rol:'admin_club',sede_id:1},null,db),filter;
  applyReservasListScopeToQuery({or(value){filter=value;}},scope);
  assert.equal(filter,'sede_id.eq.1,and(sede_id.is.null,sede.eq."Same club")');
  count=2;scope=await resolveReservasListScope({rol:'admin_club',sede_id:1},null,db);
  let equal;applyReservasListScopeToQuery({eq(...args){equal=args;}},scope);
  assert.deepEqual(equal,['sede_id',1]);
});
