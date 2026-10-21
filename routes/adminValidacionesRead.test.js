import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAdminValidationAndChannelsRoutes } from './adminValidationAndChannels.js';

function setup(role, user = {id:'admin',email:'admin@example.test'}, failure = false) {
  const routes={}; const app=Object.fromEntries(['get','post','patch'].map(m=>[m,(p,h)=>routes[`${m} ${p}`]=h]));
  const rows=[{id:1,pendiente_validacion:true,email:'one@example.test',categoria_validada:false},{id:2,pendiente_validacion:true,email:'two@example.test',categoria_validada:true},{id:3,pendiente_validacion:true,email:'three@example.test',categoria_validada:null}];
  let calls=0;
  const db={from(){calls++;let filtered=rows;const q={select(){return q},eq(k,v){filtered=filtered.filter(r=>r[k]===v);return q},gt(k,v){filtered=filtered.filter(r=>r[k]>v);return q},order(){return q},limit(){return Promise.resolve({data:failure?null:filtered.slice(0,1),error:failure?new Error('private'):null})}};return q}};
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
