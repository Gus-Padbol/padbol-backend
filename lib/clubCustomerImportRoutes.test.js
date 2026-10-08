import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerClubCustomerImportRoutes } from './clubCustomerImportRoutes.js';

async function request({scope,venues=[{id:1}],enabled=true,body={},method='post',suffix='/preview'}) {
  const routes = new Map(); let queried=false;
  const app = Object.fromEntries(['get','post'].map(method=>[method,(path,fn)=>routes.set(method+path,fn)]));
  registerClubCustomerImportRoutes(app,{pool:{query(){queried=true;return {rows:[]};}},enabled,resolveScope:async()=>scope,allowedVenues:async()=>({sedes:venues})});
  const res={code:200,set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await routes.get(method+'/api/admin/sedes/:sedeId/importaciones/clientes'+suffix)({params:{sedeId:'1'},body},res);
  return {...res,queried};
}
const admin={authUserId:'user',rol:'admin_club'};
test('unauthenticated and player access are denied before database reads',async()=>{
  assert.equal((await request({scope:null})).code,401);
  const response=await request({scope:{...admin,rol:'jugador'},method:'get',suffix:''});
  assert.equal(response.code,403);assert.equal(response.queried,false);
});
test('admin of another venue cannot read imported contacts',async()=>{
  const response=await request({scope:admin,venues:[{id:2}],method:'get',suffix:''});
  assert.equal(response.code,403);assert.equal(response.queried,false);
});
test('feature disabled fails closed',async()=>assert.equal((await request({scope:admin,enabled:false})).code,409));
test('authenticated CSV preview works and never writes',async()=>{
  const response=await request({scope:admin,body:{provider:'playtomic',csv:'ID,Nombre\n001,Ana',mapping:{externalId:0,name:1}}});
  assert.equal(response.code,200);assert.equal(response.body.canConfirm,true);assert.equal(response.queried,false);
});
test('ambiguous payload and unknown providers are rejected',async()=>{
  assert.equal((await request({scope:admin,body:{csv:'x',rows:[]}})).code,400);
  assert.equal((await request({scope:admin,body:{provider:'easycancha',rows:[['id','name'],['1','Ana']],mapping:{externalId:0,name:1}}})).code,400);
});
