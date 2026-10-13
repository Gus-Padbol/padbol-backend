import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmReservaGratuita } from './reservaGratuita.js';

const user = {id:'11111111-1111-4111-8111-111111111111',email:'qa-free@example.invalid'};
const body = {sedeId:7,precio:0,reservaData:{fecha:'2099-11-20',hora:'18:00',cancha:1,duracion:60,nombre:'QA gratuito',email:'spoof@example.invalid',user_id:'spoof'}};
const quote = {total:0,base:0,extrasSubtotal:0,fee:0,moneda:'ARS',surge:{precio:0},pricing_snapshot:{duracion_minutos:60,deporte:'padbol'}};
function fixture({ court={id:701,sede_id:7,orden:1,deporte:'padbol',estado:'activa'}, occupied=[], failedUpdate=false, suspended=false }={}) {
  const queries=[];
  const db = {from(table){
    const b={select(){return b;},eq(){return b;},in(){return b;},order(){return b;},
      maybeSingle:async()=>({data:table==='sedes'?{id:7,nombre:'QA fixture',horario_apertura:'10:00',horario_cierre:'23:00',timezone:'America/Argentina/Buenos_Aires'}:null,error:null}),
      then(resolve,reject){return Promise.resolve({data:table==='canchas'?[court]:[],error:null}).then(resolve,reject);}};
    return b;
  }};
  const client={release(){queries.push({sql:'RELEASE'});},async query(sql,params){
    queries.push({sql,params});
    if(sql.includes('FROM suspensiones_jugador')) return {rows:suspended?[{id:1,suspendido_hasta:'2099-01-01'}]:[]};
    if(sql.includes('SELECT hora,hora_inicio')) return {rows:occupied};
    if(sql.includes('SELECT id, estado FROM reservas')) return {rows:[]};
    if(sql.includes('INSERT INTO reservas')) return {rows:[{id:123}]};
    if(sql.includes('UPDATE reservas SET')) return {rows:failedUpdate?[]:[{id:123,estado:'confirmada',pago_estado:'no_aplica',precio:0,moneda:'ARS'}]};
    return {rows:[]};
  }};
  return {db,pgPool:{connect:async()=>client},queries};
}
test('free zero quote commits authenticated confirmed booking without payment credentials',async()=>{
  const f=fixture(); const result=await confirmReservaGratuita({...f,body,user,quote});
  assert.equal(result.free_booking,true);assert.equal(result.reserva_id,123);
  const insert=f.queries.find(q=>q.sql.includes('INSERT INTO reservas'));
  assert.equal(insert.params[6],'1'); // court number, not catalog PK 701
  assert.equal(insert.params[9],user.email);assert.equal(insert.params.at(-2),user.id);
  assert.equal(insert.params[13],0);assert(!insert.params.includes('mercadopago'));assert(!insert.params.includes('stripe'));
  assert(f.queries.find(q=>q.sql==='COMMIT'));
  const confirm=f.queries.find(q=>q.sql.includes('UPDATE reservas SET'));
  assert.match(confirm.sql,/payment_provider=NULL/);
  assert.deepEqual(confirm.params,[123,user.id,701]);
});
test('paid, missing, nonfinite, negative or string quotes never enter free booking',async()=>{
  for(const patch of [{total:100},{total:NaN},{total:null},{base:undefined},{fee:'0'},{surge:{precio:NaN}},{surge:{precio:null}},{extrasSubtotal:-1}]){
    const f=fixture();await assert.rejects(()=>confirmReservaGratuita({...f,body,user,quote:{...quote,...patch}}),{status:400});assert.equal(f.queries.length,0);
  }
});
test('missing identity is denied before DB; forged body owner is unused',async()=>{
  const f=fixture();await assert.rejects(()=>confirmReservaGratuita({...f,body,user:null,quote}),{status:401});assert.equal(f.queries.length,0);
});
test('no confirming unrelated existing paid reservation as free',async()=>{
  const f=fixture();await assert.rejects(()=>confirmReservaGratuita({...f,body:{...body,reserva_id:999},user,quote}),{status:400});assert.equal(f.queries.length,0);
});
test('invalid calendar date, past date and out-of-hours rejected before transaction',async()=>{
  for(const patch of [{fecha:'2099-02-31'},{fecha:'2020-01-01'},{hora:'23:30'},{hora:'25:00'}]){
    const f=fixture();await assert.rejects(()=>confirmReservaGratuita({...f,body:{...body,reservaData:{...body.reservaData,...patch}},user,quote}),{status:400});assert.equal(f.queries.length,0);
  }
});
test('wrong court/sport or quoted duration denied before transaction',async()=>{
  for(const f of [fixture({court:{id:701,sede_id:7,orden:2,deporte:'padbol'}}),fixture({court:{id:701,sede_id:7,orden:1,deporte:'tenis'}})]) await assert.rejects(()=>confirmReservaGratuita({...f,body,user,quote}),{status:400});
  const f=fixture();await assert.rejects(()=>confirmReservaGratuita({...f,body,user,quote:{...quote,pricing_snapshot:{duracion_minutos:90,deporte:'padbol'}}}),{status:400});
});
test('overlapping reservation at different start denies creation and rolls back',async()=>{
  const f=fixture({occupied:[{hora_inicio:'17:30',duracion_minutos:90}]});await assert.rejects(()=>confirmReservaGratuita({...f,body,user,quote}),{status:409});assert(f.queries.find(q=>q.sql==='ROLLBACK'));assert(!f.queries.find(q=>q.sql.includes('INSERT INTO reservas')));
});
test('suspended player rejected and failed confirmation rolls back without success',async()=>{
  const f=fixture({suspended:true});await assert.rejects(()=>confirmReservaGratuita({...f,body,user,quote}),{status:403});assert(f.queries.find(q=>q.sql==='ROLLBACK'));
  const broken=fixture({failedUpdate:true});await assert.rejects(()=>confirmReservaGratuita({...broken,body,user,quote}),/No se pudo confirmar/);assert(broken.queries.find(q=>q.sql==='ROLLBACK'));assert(!broken.queries.find(q=>q.sql==='COMMIT'));
});
