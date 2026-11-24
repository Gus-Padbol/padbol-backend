import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {registerNextGenerationAdminRoutes} from './nextGenerationAdmin.js';

test('legacy venue review retains identity boundaries and rejects all changes without database access', async()=>{
 let calls=0;
 const app=express();app.use(express.json());
 registerNextGenerationAdminRoutes(app,{
  supabaseAdmin:{from(){calls++;throw Error('Database access forbidden in retired review boundary');}},
  adminListScopeFromRequest:async req=>({super:{rol:'super_admin'},club:{rol:'admin_club',sedeId:1},player:{rol:'jugador'}}[req.headers.authorization?.replace('Bearer ','')]||null),
 });
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const call=async(actor,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/next-generation/venues/00000000-0000-4000-8000-000000000101`,{method:'PATCH',signal:AbortSignal.timeout(3000),headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor}:{})},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
  assert.deepEqual(await call(null,{estado:'aprobada'}),{status:401,body:{error:'No autorizado.',code:'NG_ADMIN_UNAUTHENTICATED'}});
  for(const actor of ['club','player']){const r=await call(actor,{estado:'aprobada'});assert.equal(r.status,403);assert.equal(r.body.code,'NG_ADMIN_FORBIDDEN');}
  for(const body of [{estado:'aprobada'},{estado:'rechazada'},{canonical_sede_id:2}]){
   const r=await call('super',body);assert.equal(r.status,409);assert.equal(r.body.code,'NG_VENUE_REVIEW_REQUIRES_OFFICIAL_FLOW');assert.match(r.body.error,/circuito oficial/);
  }
  assert.equal(calls,0,'no Supabase reads or writes for any request');
 }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});
