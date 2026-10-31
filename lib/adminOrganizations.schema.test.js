import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAdminOrganizationsRoutes, organizationErrorResponse } from './adminOrganizations.js';
function harness(failure, organizationRows = [{id:'550e8400-e29b-41d4-a716-446655440000'}]) {
 const routes = new Map(); const writes=[];
 const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,handler)=>routes.set(method+' '+path,handler)]));
 const supabase={from(table){return {select(){return this;},order(){return Promise.resolve({data:table==='organizaciones'?organizationRows:[]});},limit(){return Promise.resolve({data:[],error:typeof failure==='function'?failure(table):failure});},insert(){writes.push(table);throw Error('write reached');}};}};
 registerAdminOrganizationsRoutes(app,{supabase,adminListScopeFromRequest:async()=>({superA:true}),assertSuperAdminReq:async()=>{},generateAdminInviteMagicLink:async()=>{throw Error('provider reached');}});
 const res={statusCode:200,status(value){this.statusCode=value;return this;},json(body){this.body=body;return this;}};
 return {routes,writes,res};
}
for(const code of ['42P01','42703','PGRST204','PGRST205']) test('schema '+code+' is controlled, never an empty list',async()=>{
 const h=harness({code,message:'private db detail'});
 await h.routes.get('get /api/admin/organizaciones')({},h.res);
 assert.equal(h.res.statusCode,503);assert.equal(h.res.body.code,'ORGANIZATIONS_SCHEMA_UNAVAILABLE');assert.ok(!JSON.stringify(h.res.body).includes('private'));
});
test('all mutations fail before any write or invitation when schema is missing',async()=>{
 const h=harness({code:'42P01',message:'missing'});
 for(const [key,handler] of h.routes) if(!key.startsWith('get ')) {
  await handler({body:{nombre:'Duplicate'},params:{}},h.res);
  assert.equal(h.res.statusCode,503,key);
 }
 assert.deepEqual(h.writes,[]);
});
test('permission and transient errors are not mislabeled as missing schema',()=>{
 assert.equal(organizationErrorResponse({code:'42501',message:'denied'}).status,500);
 assert.equal(organizationErrorResponse({code:'08006',message:'connection'}).status,500);
});

for(const table of ['organizacion_sedes','invitaciones_admin','sedes_pendientes']) test('missing dependency '+table+' blocks creation',async()=>{
 const h=harness(name=>name===table?{code:table==='organizacion_sedes'?'42P01':'42703',message:'missing'}:null);
 await h.routes.get('post /api/admin/organizaciones')({body:{nombre:'Duplicate'}},h.res);
 assert.equal(h.res.statusCode,503);assert.deepEqual(h.writes,[]);
});
test('only a valid empty read returns an empty list; missing schema never does, even without organizations',async()=>{
 const valid=harness(null,[]);await valid.routes.get('get /api/admin/organizaciones')({},valid.res);assert.equal(valid.res.statusCode,200);assert.deepEqual(valid.res.body,[]);
 const broken=harness({code:'42P01',message:'missing'},[]);await broken.routes.get('get /api/admin/organizaciones')({},broken.res);assert.equal(broken.res.statusCode,503);
});
