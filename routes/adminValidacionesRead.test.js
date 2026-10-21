import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAdminValidationAndChannelsRoutes } from './adminValidationAndChannels.js';

function setup(role, user = {id:'admin',email:'admin@example.test'}, failure = false, overrideRows = null) {
  const routes={}; const app=Object.fromEntries(['get','post','patch'].map(m=>[m,(p,h)=>routes[`${m} ${p}`]=h]));
  const rows=[{id:1,user_id:'00000000-0000-0000-0000-000000000001',pendiente_validacion:true,email:'one@example.test',categoria_validada:false},{id:2,user_id:'00000000-0000-0000-0000-000000000002',pendiente_validacion:true,email:'two@example.test',categoria_validada:true},{id:3,user_id:null,pendiente_validacion:true,email:'three@example.test',categoria_validada:null}];
  if (overrideRows) rows.splice(0, rows.length, ...overrideRows);
  let calls=0;
  const db={from(){calls++;let filtered=rows;const q={select(){return q},eq(k,v){filtered=filtered.filter(r=>r[k]===v);return q},gt(k,v){filtered=filtered.filter(r=>r[k]>v);return q},is(k,v){filtered=filtered.filter(r=>r[k]===v);return q},not(k,op,v){filtered=filtered.filter(r=>r[k]!==v);return q},order(){return q},limit(){return Promise.resolve({data:failure?null:filtered.slice(0,1),error:failure?new Error('private'):null})}};return q}};
  mountAdminValidationAndChannelsRoutes(app,{supabaseAdmin:db,getAuthenticatedUser:async()=>({user,status:401,error:'Unauthorized'}),fetchUserRoleRowForAuthUser:async()=>role,env:{}});
  return {handler:routes['get /api/admin/validaciones'],calls:()=>calls};
}
async function invoke(handler){const res={code:200,status(c){this.code=c;return this},json(v){this.body=v;return this}};await handler({},res);return res;}
test('superadmin recibe todas las páginas y no ve como pendiente la categoría ya validada',async()=>{
  const x=setup({role:'super_admin'});const res=await invoke(x.handler);
  assert.equal(res.code,200);assert.deepEqual(res.body.validaciones.map(r=>r.id),[1,3]);assert.equal(x.calls(),4);
});
test('sin sesión y sin rol de superadmin no se accede a datos',async()=>{
  for(const x of [setup(null,null),setup({role:'admin_club',sede_id:7})]){const res=await invoke(x.handler);assert.ok([401,403].includes(res.code));assert.equal(x.calls(),0);}
});
test('fallo de base no se convierte en listado vacío',async()=>{
  const res=await invoke(setup({role:'super_admin'},undefined,true).handler);assert.equal(res.code,500);assert.equal(res.body.validaciones,undefined);
});

test('rechaza identificadores bigint numéricos imprecisos sin devolver datos parciales',async()=>{
 const res=await invoke(setup({role:'super_admin'},undefined,false,[{id:9007199254740992,pendiente_validacion:true,user_id:null}]).handler);
 assert.equal(res.code,500);assert.equal(res.body.validaciones,undefined);
});

test('escritura por PK exige superadmin y limita cambios a una fila pendiente', async()=>{
  for (const role of [null,{role:'admin_club',sede_id:7}]) {
    const routes={}; let touched=false; const app={get(){},post(){},patch(p,h){routes[p]=h}};
    mountAdminValidationAndChannelsRoutes(app,{supabaseAdmin:{from(){touched=true}},getAuthenticatedUser:async()=>({user:{id:'fixture'}}),fetchUserRoleRowForAuthUser:async()=>role,env:{}});
    const res={code:200,status(c){this.code=c;return this},json(v){this.body=v;return this}};
    await routes['/api/admin/validaciones/perfil/:id']({params:{id:'12'},body:{accion:'aprobar'}},res);
    assert.equal(res.code,403);assert.equal(touched,false);
  }
  const routes={};const calls=[];const app={get(){},post(){},patch(p,h){routes[p]=h}};
  const q={update(v){calls.push(['update',v]);return this},eq(k,v){calls.push(['eq',k,v]);return this},select(){return this},async maybeSingle(){return {data:{id:12},error:null}}};
  mountAdminValidationAndChannelsRoutes(app,{supabaseAdmin:{from(){return q}},getAuthenticatedUser:async()=>({user:{id:'fixture'}}),fetchUserRoleRowForAuthUser:async()=>({role:'super_admin'}),env:{}});
  const run=async(id,body)=>{const res={code:200,status(c){this.code=c;return this},json(v){this.body=v;return this}};await routes['/api/admin/validaciones/perfil/:id']({params:{id},body},res);return res};
  assert.equal((await run('12',{accion:'categoria',nivel:'3ra'})).code,200);
  assert.deepEqual(calls,[['update',{pendiente_validacion:false,nivel:'3ra'}],['eq','id','12'],['eq','pendiente_validacion',true]]);
  assert.equal((await run('12',{accion:'categoria',nivel:'inventada'})).code,400);
  assert.equal((await run('12',{accion:'rechazar',motivo:'x'})).code,400);
  assert.equal((await run('9223372036854775808',{accion:'aprobar'})).code,400);
  q.maybeSingle=async()=>({data:null,error:null});assert.equal((await run('12',{accion:'aprobar'})).code,409);
  q.maybeSingle=async()=>({data:null,error:new Error('fixture')});assert.equal((await run('12',{accion:'aprobar'})).code,500);
});
