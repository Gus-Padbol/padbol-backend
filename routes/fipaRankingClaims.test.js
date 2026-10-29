import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {mountFipaRankingClaimRoutes} from './fipaRankingClaims.js';
const key='a'.repeat(64),player={source_key:key,nombre_completo:'Official Player',pais:'Romania',puntos:2180,posicion:1};
async function server(user,fn){let queries=[];const app=express();app.use(express.json());mountFipaRankingClaimRoutes(app,{pgPool:{query:async(s)=>{queries.push(s);return {rows:[],rowCount:0}}},getAuthenticatedUser:async()=>({user,status:401}),fetchUserRoleRowForAuthUser:async()=>({role:'player'}),loadSource:async()=>({players:[player]})});const srv=app.listen(0);await new Promise(r=>srv.once('listening',r));try{await fn(`http://127.0.0.1:${srv.address().port}`,queries);}finally{await new Promise(r=>srv.close(r));}}
test('listar y preparar invitaciones requieren sesión y permiso específico; no usa email allowlist',async()=>{
 await server(null,async(base,queries)=>{assert.equal((await fetch(base+'/api/admin/fipa/jugadores')).status,401);assert.equal(queries.length,0)});
 await server({id:'actor',email:'jpgarcia1710@gmail.com'},async(base,queries)=>{assert.equal((await fetch(base+'/api/admin/fipa/jugadores')).status,403);assert.ok(queries[0].includes('fipa_ranking_operators'));assert.equal((await fetch(base+`/api/admin/fipa/jugadores/${key}/invitacion`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403)});
});
test('token inválido y aceptación sin sesión no cambian identidad ni puntos',async()=>{await server(null,async(base,queries)=>{
 const response=await fetch(base+'/api/fipa/invitaciones/validar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"token":"invalid"}'});assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await fetch(base+'/api/fipa/invitaciones/aceptar',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);assert.equal(queries.length,0);
});});
test('autoservicio requiere sesión y la aprobación exige rol de coordinación persistido',async()=>{
 await server(null,async(base,queries)=>{
  for(const [path,method] of [['/api/fipa/solicitudes','GET'],['/api/fipa/solicitudes','POST'],['/api/admin/fipa/solicitudes','GET'],['/api/admin/fipa/solicitudes/11111111-1111-4111-8111-111111111111/resolver','POST']])assert.equal((await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})})).status,401);
  assert.equal(queries.length,0);
 });
 await server({id:'actor',email:'jpgarcia1710@gmail.com'},async(base)=>{
  assert.equal((await fetch(base+'/api/admin/fipa/solicitudes')).status,403);
  assert.equal((await fetch(base+'/api/admin/fipa/solicitudes/11111111-1111-4111-8111-111111111111/resolver',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'approved',nota:'Soy el propietario'})})).status,403);
 });
});
