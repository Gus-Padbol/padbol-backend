import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountJugadorIdentidadRoutes} from '../routes/jugadorIdentidad.js';

const user={id:'11111111-1111-4111-8111-111111111111',email:'synthetic@example.invalid'};
const payload={fecha_nacimiento:'1990-01-01',tipo_documento:'pasaporte',pais_documento:'AR',numero_documento:'QA123456',nacionalidad:'AR',telefono:'+54 11 1234-5678'};
function identityStore(initial=null){
 let row=initial?{...initial}:null;const writes=[];
 return {writes,get row(){return row},from(table){
  assert.equal(table,'jugadores_identidad');let owner;
  const query={select(){return query},eq(key,value){assert.equal(key,'user_id');owner=value;return query},async maybeSingle(){return{data:row?.user_id===owner?{...row}:null,error:null}},upsert(patch){writes.push(structuredClone(patch));row={...(row||{}),...patch};return{select(){return this},async single(){return{data:{...row},error:null}}}}};return query;
 }};
}
test('real identity PUT route/service saves a new Napoli document without hidden gender/category and preserves existing sporting identity',async()=>{
 for(const initial of [null,{user_id:user.id,genero:'otro',categoria_deportiva:'Saved category'}]){
  const db=identityStore(initial);const app=express();app.use(express.json());const router=express.Router();
  mountJugadorIdentidadRoutes(router,{supabaseAdmin:db,getAuthenticatedUser:async()=>({user})});app.use('/api/jugador',router);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/jugador/identidad`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const body=await response.json();assert.equal(response.status,200);assert.equal(body.completitud.documento_completo,true);assert.equal(body.completitud.identidad_minima_completa,true);assert.equal(body.fecha_nacimiento,payload.fecha_nacimiento);assert.equal(body.numero_documento_last4,'3456');assert.equal(body.telefono,payload.telefono);
   assert.equal(body.genero,initial?.genero??null);assert.equal(body.categoria_deportiva,initial?.categoria_deportiva??null);
   assert.equal(db.writes.length,1);assert.equal(Object.hasOwn(db.writes[0],'genero'),false);assert.equal(Object.hasOwn(db.writes[0],'categoria_deportiva'),false);assert.ok(db.row.numero_documento_hash);assert.ok(db.row.numero_documento_cifrado);assert.equal(Object.hasOwn(body,'numero_documento_hash'),false);assert.equal(Object.hasOwn(body,'numero_documento_cifrado'),false);
  }finally{await new Promise(resolve=>server.close(resolve))}
 }
});
