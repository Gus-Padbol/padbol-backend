import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {assertCancelReservaOwnerCompat} from './reservaAccess.js';
import {horasAnticipacionReserva} from './reservaCancelacionTiming.js';
import {reservaHoraInicioFromRow} from '../utils/reservasColumns.js';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf("app.post('/api/cancelar-reserva',");
const route=source.slice(start,source.indexOf('\n});',start)+5);
const owner={id:'qa-owner',email:'qa-owner@example.invalid'};
function response(){return{headersSent:false,statusCode:200,status(c){this.statusCode=c;return this;},json(body){this.body=body;this.headersSent=true;return this;}};}
function fixture({state=null,user=owner,role={role:'jugador'}}={}){
 let handler;const writes=[],effects=[],reads=[];
 const row={id:123,sede_id:7,sede:'QA fixture',cancha:'1',fecha:'2099-11-20',hora:'18:00 - 19:00',hora_inicio:'18:00',duracion_minutos:60,user_id:owner.id,email:owner.email,precio:0,estado:state,whatsapp:null};
 const db={from(table){reads.push(table);let patch=null,filter=null;
   const b={select(){return b;},eq(){return b;},or(value){filter=value;return b;},update(value){patch=value;return b;},async maybeSingle(){
     if(table==='sedes')return{data:{timezone:'America/Argentina/Buenos_Aires',nombre:'QA fixture'},error:null};
     if(table==='reservas'){
       if(patch){assert.equal(filter,'estado.is.null,estado.neq.cancelada');if(row.estado==='cancelada')return{data:null,error:null};writes.push(patch);Object.assign(row,patch);return{data:{id:row.id},error:null};}
       return{data:{...row},error:null};
     }
     throw new Error('Unexpected table '+table);
   }};return b;
 }};
 const ctx={app:{post(_path,_limiter,fn){handler=fn;}},reservasWriteRateLimit(){},supabaseAdmin:db,pgPool:{query:async(_sql,args)=>({rows:[{nombre:args?.[0]===7?'QA fixture':'Other venue'}]})},
   getAuthenticatedUser(){},requireAuthenticatedUser:async(_req,res)=>{if(!user)res.status(401).json({error:'No autorizado'});return user;},
   assertCancelReservaOwnerCompat,fetchUserRoleRowForAuthUser:async()=>role,LEGACY_SUPER_ADMIN_EMAILS_API:[],
   horasAnticipacionReserva,reservaHoraInicioFromRow,
   revertirPadcoinsParticipacionPorReserva:async()=>{effects.push('reversal');return{};},
   procesarReputacionTrasCancelacion:async(_pg,args)=>{effects.push('reputacion');assert.equal(args.hora,'18:00');return{};},
   PENALIZACION_UMBRAL_HORAS:24,penalizarPadcoinsPorCancelacionTarde:async()=>{throw new Error('Unexpected late penalty');},
   console:{log(){},warn(){},error(){}},sanitizeClientErrorMessage:e=>e.message,sendHttpError:(res,e)=>res.status(500).json({error:e.message})};
 vm.runInNewContext(route,ctx);
 return{handler,row,writes,effects,reads};
}
test('actual cancellation handler accepts NULL legacy status, no credit for free price, retry409 without repeat effects',async()=>{
 const f=fixture();const res=response();await f.handler({body:{reservaId:123,email:owner.email}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);assert.equal(f.row.estado,'cancelada');assert.equal(f.writes.length,1);assert.equal(res.body.credito,null);assert(!f.reads.includes('creditos'));
 assert.deepEqual(f.effects,['reversal','reputacion']);const retry=response();await f.handler({body:{reservaId:123}},retry);assert.equal(retry.statusCode,409);assert.equal(f.effects.length,2);
});
test('actual cancellation handler denies stranger even with forged owner email',async()=>{
 const f=fixture({user:{id:'qa-stranger',email:'qa-stranger@example.invalid'}});const res=response();await f.handler({body:{reservaId:123,email:owner.email}},res);assert.equal(res.statusCode,403);assert.equal(f.writes.length,0);assert.equal(f.effects.length,0);
});
test('actual cancellation handler permits own venue admin and denies foreign venue admin',async()=>{
 for(const[sede_id,status]of[[7,200],[8,403]]){
  const f=fixture({user:{id:'qa-admin',email:'qa-admin@example.invalid'},role:{role:'admin_club',sede_id}});const res=response();await f.handler({body:{reservaId:123}},res);assert.equal(res.statusCode,status);assert.equal(f.writes.length,status===200?1:0);
 }
});
test('actual cancellation handler denies anonymous request',async()=>{
 const f=fixture({user:null});const res=response();await f.handler({body:{reservaId:123}},res);assert.equal(res.statusCode,401);assert.equal(f.writes.length,0);
});
