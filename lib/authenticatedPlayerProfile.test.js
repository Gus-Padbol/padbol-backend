import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { decodeProfilePhoto, MAX_PROFILE_PHOTO_BYTES } from './profilePhotoPayload.js';
import {
  AUTHENTICATED_PROFILE_SELECT,
  readAuthenticatedPlayerProfile,
  updateAuthenticatedPlayerProfile,
} from './authenticatedPlayerProfile.js';

const uid = '11111111-1111-4111-8111-111111111111';
const otherUid = '22222222-2222-4222-8222-222222222222';
const user = { id: uid, email: 'fixture@example.test' };
const owned = () => ({ id: 1, user_id: uid, email: user.email, nombre: 'Fixture', alias: 'fixture_alias', whatsapp: '+12025550108', fecha_nacimiento: '2000-01-01', foto_url: 'fixture.jpg' });
function database(initial, options = {}) {
  const state = { rows: structuredClone(initial), calls: [], writes: 0 };
  state.from = table => {
    assert.equal(table, 'jugadores_perfil');
    const call = { filters: [], select: null, patch: null };
    state.calls.push(call);
    const q = {
      select(columns) { call.select = columns; return q; },
      then(resolve,reject) { return q.limit(Infinity).then(resolve,reject); },
      eq(key, value) { call.filters.push([key, value]); return q; },
      is(key, value) { call.filters.push([key, value]); return q; },
      update(patch) { call.patch = patch; return q; },
      async limit(count) {
        if (options.error) return { data: null, error: options.error };
        if (call.patch && options.errorOnWrite) return { data: null, error: options.errorOnWrite };
        if (call.patch && options.beforeWrite) options.beforeWrite(state);
        const matches = state.rows.filter(row => call.filters.every(([key,value]) => row[key] === value));
        if (call.patch) {
          for (const row of matches) Object.assign(row, call.patch);
          state.writes += matches.length;
        }
        return { data: structuredClone(matches.slice(0,count)), error: null };
      },
    };
    return q;
  };
  return state;
}
test('UUID wins over a legacy or foreign row sharing the email', async () => {
  const db = database([owned(), { id: 2, user_id: null, email: user.email }, { id: 3, user_id: otherUid, email: user.email }]);
  assert.equal((await readAuthenticatedPlayerProfile(db,user)).id, 1);
  assert.equal(db.calls.length,1);
});
test('legacy fallback is email plus NULL owner and does not claim on read', async () => {
  const db = database([{ id: 2, user_id: null, email: user.email }]);
  assert.equal((await readAuthenticatedPlayerProfile(db,user)).user_id,null);
  assert.deepEqual(db.calls[1].filters,[['email',user.email],['user_id',null]]);
  assert.equal(db.writes,0);
});
test('a foreign UUID with matching email is not a fallback', async () => {
  assert.equal(await readAuthenticatedPlayerProfile(database([{ id:2,user_id:otherUid,email:user.email }]),user),null);
});
test('ambiguous UUID/legacy and database errors fail without fallback', async () => {
  for (const fixture of [[owned(),owned()],[{ id:2,user_id:null,email:user.email },{ id:3,user_id:null,email:user.email }]]) {
    await assert.rejects(readAuthenticatedPlayerProfile(database(fixture),user),{code:'PROFILE_AMBIGUOUS'});
  }
  const err = new Error('fixture unavailable');
  const db = database([],{error:err});
  await assert.rejects(readAuthenticatedPlayerProfile(db,user),err);
  assert.equal(db.calls.length,1);
});
test('update is id plus UUID, returns exact row, preserves omitted fields', async () => {
  const db=database([owned(),{id:2,user_id:otherUid,email:user.email,nombre:'Other'}]);
  const row=await updateAuthenticatedPlayerProfile(db,user,owned(),{nombre:'New'});
  assert.equal(row.id,1);
  assert.deepEqual(db.calls[0].filters,[['id',1],['user_id',uid]]);
  assert.equal(row.alias,'fixture_alias');
  assert.equal(row.foto_url,'fixture.jpg');
  assert.equal(row.fecha_nacimiento,'2000-01-01');
  assert.equal(db.rows[1].nombre,'Other');
});
test('legacy claim is conditional on id, NULL and verified email', async () => {
  const current={id:2,user_id:null,email:user.email};
  const db=database([current]);
  assert.equal((await updateAuthenticatedPlayerProfile(db,user,current,{nombre:'New'})).user_id,uid);
  assert.deepEqual(db.calls[0].filters,[['id',2],['user_id',null],['email',user.email]]);
});
test('concurrent legacy claim fails closed with no email retry', async () => {
  const current={id:2,user_id:null,email:user.email};
  const db=database([current],{beforeWrite(state){state.rows[0].user_id=otherUid;}});
  await assert.rejects(updateAuthenticatedPlayerProfile(db,user,current,{nombre:'New'}),{code:'PROFILE_WRITE_CONFLICT'});
  assert.equal(db.writes,0);
  assert.equal(db.calls.length,1);
});
test('foreign ownership, identity patch and zero/multiple returned rows are rejected', async () => {
  await assert.rejects(updateAuthenticatedPlayerProfile(database([]),user,{...owned(),user_id:otherUid},{nombre:'No'}),{code:'PROFILE_IDENTITY_UNVERIFIED'});
  await assert.rejects(updateAuthenticatedPlayerProfile(database([]),user,owned(),{user_id:otherUid}),{code:'PROFILE_IDENTITY_PATCH_REJECTED'});
  await assert.rejects(updateAuthenticatedPlayerProfile(database([]),user,owned(),{nombre:'No'}),{code:'PROFILE_WRITE_CONFLICT'});
  await assert.rejects(updateAuthenticatedPlayerProfile(database([owned(),owned()]),user,owned(),{nombre:'No'}),{code:'PROFILE_AMBIGUOUS'});
});

// Execute the actual handler/function source, without importing server startup,
// scheduling jobs, using network, or copying an imitation of handler control flow.
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
function actual(name,endMarker,deps){
  const start=source.indexOf(`async function ${name}(`);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0 && end>start);
  return new Function(...Object.keys(deps),`${source.slice(start,end)}; return ${name};`)(...Object.values(deps));
}
function response(){ return {statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}}; }
function dependencies(db){
  const deps={
    supabaseAdmin:db,
    getAuthenticatedUser:async()=>({user}),
    readAuthenticatedPlayerProfile,updateAuthenticatedPlayerProfile,
    resolvePerfilDeportes:async()=>['padbol'],
    fetchIdentidadForPerfil:async()=>({fecha_nacimiento:'1999-02-03'}),
    fetchCompaneroHabitualById:async()=>null,
    perfilBodyHasIdentidadFields:()=>false,
    syncJugadorDeportesForUser:async()=>{},
    validateCiudad:v=>v,UUID_REGEX:/^[a-f0-9-]{36}$/i,
    sendHttpError:(res,error)=>res.status(error.status??500).json({error:error.message,code:error.code}),
    console:{log(){},error(){}},
  };
  deps.buildAuthenticatedPerfilPayload=actual('buildAuthenticatedPerfilPayload','const jugadorRouter',deps);
  return deps;
}
test('real private GET exposes stored owner and separate verified requester, alias/WhatsApp, canonical identity date',async()=>{
  for(const owner of [uid,null]){
    const db=database([{...owned(),user_id:owner}]);
    const deps=dependencies(db);
    const handler=actual('handleGetAuthenticatedPerfil','async function handlePutAuthenticatedPerfil',deps);
    const res=response();await handler({},res);
    assert.equal(res.statusCode,200);
    assert.equal(res.body.user_id,owner);
    assert.equal(res.body.authenticated_user_id,uid);
    assert.equal(res.body.id,1);
    assert.equal(res.body.alias,'fixture_alias');
    assert.equal(res.body.whatsapp,'+12025550108');
    assert.equal(res.body.fecha_nacimiento,'1999-02-03');
    assert.equal(db.writes,0);
  }
});
test('real PUT updates only resolved owner and preserves alias/photo/date omitted in request',async()=>{
  const db=database([owned(),{id:2,user_id:otherUid,email:user.email,nombre:'Other'}]);
  const deps=dependencies(db);
  const handler=actual('handlePutAuthenticatedPerfil','// GET /api/jugador/perfil',deps);
  const res=response();await handler({body:{nombre:'New'}},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.nombre,'New');
  assert.equal(res.body.alias,'fixture_alias');
  assert.equal(res.body.foto_url,'fixture.jpg');
  assert.equal(db.rows[0].fecha_nacimiento,'2000-01-01');
  assert.equal(db.rows[1].nombre,'Other');
});
test('real PUT missing/conflicted row returns error, never success',async()=>{
  for(const db of [database([]),database([owned()],{beforeWrite(state){state.rows[0].user_id=otherUid;}})]){
    const handler=actual('handlePutAuthenticatedPerfil','// GET /api/jugador/perfil',dependencies(db));
    const res=response();await handler({body:{nombre:'No'}},res);
    assert.ok(res.statusCode===404 || res.statusCode===409);
    assert.equal(res.body.nombre,undefined);
    assert.equal(db.writes,0);
  }
});
test('public /perfiles DTO remains unchanged and does not gain private fields',()=>{
  const start=source.indexOf("jugadorRouter.get('/perfiles'");
  const end=source.indexOf('// GET /api/jugador/rankings',start);
  const body=source.slice(start,end);
  assert.match(body,/select\('user_id, nombre, nombre_saludo, apodo, username, foto_url'\)/);
  assert.doesNotMatch(body,/whatsapp|telefono|fecha_nacimiento|authenticated_user_id/);
  assert.match(AUTHENTICATED_PROFILE_SELECT,/alias/);
});

function photoFixture(db, options={}) {
  const storage={uploads:[],from(bucket){
    assert.equal(bucket,'fotos-perfil');
    return {
      async upload(path,buffer,config){storage.uploads.push({path,bytes:buffer.length,config});return {error:options.uploadError??null};},
      getPublicUrl(path){return {data:options.noUrl?{}:{publicUrl:`https://fixture.invalid/${path}`}};},
    };
  }};
  db.storage=storage;
  const deps={...dependencies(db),decodeProfilePhoto,randomUUID:()=> '33333333-3333-4333-8333-333333333333'};
  if(options.noAuth)deps.getAuthenticatedUser=async()=>({user:null,status:401,error:'Unauthorized'});
  const marker="usuariosRouter.post('/foto-perfil', ";
  const start=source.indexOf(marker)+marker.length;
  const end=source.indexOf('// GET /api/usuarios/perfil-publico',start);
  const expression=source.slice(start,end).trim().replace(/\);$/,'');
  assert.match(expression,/^async \(req, res\) =>/);
  const handler=new Function(...Object.keys(deps),`return (${expression});`)(...Object.values(deps));
  return {handler,storage};
}
const photoBody={foto_base64:Buffer.from('synthetic-image-fixture').toString('base64'),mime_type:'image/jpeg'};
test('real photo route resolves UUID before Storage, uses unique INSERT and updates exact owner',async()=>{
  const db=database([owned(),{id:2,user_id:otherUid,email:user.email,foto_url:'other.jpg'}]);
  const {handler,storage}=photoFixture(db);
  const res=response();await handler({body:photoBody},res);
  assert.equal(res.statusCode,200);
  assert.equal(storage.uploads.length,1);
  assert.equal(storage.uploads[0].path,`${uid}/33333333-3333-4333-8333-333333333333.jpg`);
  assert.equal(storage.uploads[0].config.upsert,false);
  assert.equal(db.rows[0].foto_url,res.body.foto_url);
  assert.equal(db.rows[1].foto_url,'other.jpg');
  assert.deepEqual(db.calls[1].filters,[['id',1],['user_id',uid]]);
});
test('real photo route blocks unauthenticated, foreign-email-only and ambiguous rows before Storage',async()=>{
  for(const [db,options,status] of [
    [database([owned()]),{noAuth:true},401],
    [database([{id:2,user_id:otherUid,email:user.email}]),{},404],
    [database([owned(),owned()]),{},409],
  ]){
    const {handler,storage}=photoFixture(db,options);
    const res=response();await handler({body:photoBody},res);
    assert.equal(res.statusCode,status);
    assert.equal(storage.uploads.length,0);
    assert.equal(db.writes,0);
  }
});
test('real photo route database error/zero rows never reports success; previous object is not overwritten',async()=>{
  for(const db of [
    database([owned()],{errorOnWrite:new Error('fixture write failed')}),
    database([owned()],{beforeWrite(state){state.rows[0].user_id=otherUid;}}),
  ]){
    const {handler,storage}=photoFixture(db);
    const res=response();await handler({body:photoBody},res);
    assert.ok(res.statusCode>=400);
    assert.equal(res.body.foto_url,undefined);
    assert.equal(db.rows[0].foto_url,'fixture.jpg');
    assert.equal(storage.uploads.length,1); // New orphan is retained, no irreversible deletion.
    assert.equal(storage.uploads[0].config.upsert,false);
  }
});
test('real photo route upload failure or missing URL never changes the profile',async()=>{
  for(const options of [{uploadError:new Error('fixture storage unavailable')},{noUrl:true}]){
    const db=database([owned()]);const {handler}=photoFixture(db,options);
    const res=response();await handler({body:photoBody},res);
    assert.ok(res.statusCode>=400);
    assert.equal(db.writes,0);
    assert.equal(db.rows[0].foto_url,'fixture.jpg');
  }
});
test('real photo route keeps decoded 5MiB boundary and MIME validation before upload',async()=>{
  for(const [body,status] of [
    [{foto_base64:'',mime_type:'image/jpeg'},400],
    [{foto_base64:'eA==',mime_type:'text/plain'},400],
    [{foto_base64:Buffer.alloc(MAX_PROFILE_PHOTO_BYTES+1).toString('base64'),mime_type:'image/jpeg'},400],
  ]){
    const db=database([owned()]);const {handler,storage}=photoFixture(db);
    const res=response();await handler({body},res);
    assert.equal(res.statusCode,status); // Existing API contract is 400 PHOTO_TOO_LARGE.
    assert.equal(storage.uploads.length,0);
  }
  const db=database([owned()]);const {handler,storage}=photoFixture(db);
  const res=response();await handler({body:{foto_base64:Buffer.alloc(MAX_PROFILE_PHOTO_BYTES).toString('base64'),mime_type:'image/jpeg'}},res);
  assert.equal(res.statusCode,200);
  assert.equal(storage.uploads[0].bytes,MAX_PROFILE_PHOTO_BYTES);
});

// Use the installed SDK request builder, with every fetch intercepted offline.
// A row-scoped PATCH must not emit PostgREST's limited-update query without order.
test('real SDK PATCH has id/owner filters and RETURNING but no UPDATE limit',async()=>{
  const requests=[];
  const db=createClient('https://fixture.invalid','fixture-public-key',{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:async(input,init)=>{
      requests.push({url:String(input),init});
      return new Response(JSON.stringify([{...owned(),nombre:'New'}]),{status:200,headers:{'content-type':'application/json'}});
    }},
  });
  const result=await updateAuthenticatedPlayerProfile(db,user,owned(),{nombre:'New'});
  assert.equal(result.nombre,'New');
  assert.equal(requests.length,1);
  const {url,init}=requests[0];
  const query=new URL(url).searchParams;
  assert.equal(init.method,'PATCH');
  assert.equal(query.get('id'),'eq.1');
  assert.equal(query.get('user_id'),`eq.${uid}`);
  assert.equal(query.has('limit'),false);
  assert.ok(query.has('select'));
  assert.deepEqual(JSON.parse(init.body),{nombre:'New'});
});
