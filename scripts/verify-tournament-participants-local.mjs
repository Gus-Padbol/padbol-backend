/** Real localhost HTTP/Express + disposable PostgreSQL; synthetic authentication adapter, never production. */
import express from 'express';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomUUID} from 'node:crypto';
import {mountTournamentParticipantsRoutes} from '../routes/tournamentParticipants.js';
const exec=promisify(execFile),argv=['--context','colima','exec','jefe4-calendar-review-20261015','psql','-U','postgres','-d','participants_qa16','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-c'];
const actors={admin:'11111111-1111-4111-8111-111111111111',cap:'22222222-2222-4222-8222-000000000001',claim:'22222222-2222-4222-8222-000000000003',foreign:'99999999-9999-4999-8999-999999999999'};const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
async function sql(text){return (await exec('docker',[...argv,text])).stdout.trim();}
assert.equal(await sql('SELECT current_database();'),'participants_qa16');
const reset="TRUNCATE public.scoreboard_partidos,public.partidos,public.equipos,public.torneo_participantes,public.torneo_participante_operaciones,public.torneo_homologaciones CASCADE;UPDATE public.torneos SET estado='abierto' WHERE id=555;";
await sql(reset);const db={async rpc(name,p){assert.ok(['gestionar_participantes_torneo','gestionar_acreditacion_participante'].includes(name));try{return{data:JSON.parse(await sql('SELECT public.'+name+'('+Number(p.p_torneo_id)+','+quote(p.p_actor_id)+'::uuid,'+quote(p.p_accion)+','+quote(JSON.stringify(p.p_payload))+'::jsonb);')),error:null}}catch(e){return{data:null,error:{code:e.stderr.match(/ERROR:\s+([A-Z0-9]{5})/)?.[1]||'XX000'}}}}};
const app=express();app.use(express.json());mountTournamentParticipantsRoutes(app,{db,getAuthenticatedUser:async req=>({user:actors[req.headers.authorization]?{id:actors[req.headers.authorization]}:null,status:401})});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/torneos/555';let checks=0;
async function call(actor,path,method='GET',body,expected=200){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:actor}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.equal(response.status,expected,path+' '+JSON.stringify(data));checks++;return data;}
try{
 await call(null,'/participantes','GET',undefined,401);
 const before=await call('admin','/participantes');assert.equal(before.can_manage,true);assert.equal(before.participants.length,0);
 await call('foreign','/participantes','POST',{request_id:randomUUID(),nombre:'Foreign',tipo_identidad:'generico'},403);
 const body={request_id:randomUUID(),nombre:'Captain with pending colleague',incluir_capitan:false,participantes:[{tipo_identidad:'plaza_pendiente'}]};
 const created=await call('cap','/inscripciones-participantes','POST',body,201);assert.equal(created.equipo.participants.length,2);assert.equal(created.equipo.habilitacion_deportiva.habilitado,false);assert.equal(created.equipo.participants[0].user_id,actors.cap);
 const retried=await call('cap','/inscripciones-participantes','POST',body);assert.equal(retried.equipo.id,created.equipo.id);
 await call('cap','/inscripciones-participantes','POST',{...body,request_id:randomUUID()},409);
 const pending=created.equipo.participants[1].participante_id;
 await call('cap','/participantes/'+pending,'PATCH',{request_id:randomUUID(),nombre:'Named guest',tipo_identidad:'generico'});
 const reread=await call('cap','/participantes');assert.equal(reread.teams[0].habilitacion_deportiva.habilitado,true);assert.equal(reread.teams[0].participants[1].id,pending);assert.equal(reread.teams[0].participants[1].can_edit,true);assert.equal(reread.teams[0].participants[1].user_id,null);
 const claim=await call('claim','/participantes/'+pending+'/vinculacion','POST',{request_id:randomUUID()},201);
 await call('foreign','/vinculaciones/'+claim.solicitud.id+'/resolver','POST',{request_id:randomUUID(),decision:'aprobar'},403);
 await call('admin','/vinculaciones/'+claim.solicitud.id+'/resolver','POST',{request_id:randomUUID(),decision:'aprobar'});
 const linked=await call('claim','/participantes');assert.equal(linked.participants.find(p=>p.id===pending).estado_vinculacion,'vinculado');assert.equal(linked.participants.find(p=>p.id===pending).ranking_oficial_elegible,false);
 const accreditation=await call('claim','/participantes/'+pending+'/acreditacion','POST',{request_id:randomUUID()},201);
 await call('admin','/acreditaciones/'+accreditation.solicitud.id+'/resolver','POST',{request_id:randomUUID(),decision:'aprobar'},403);
 console.log(JSON.stringify({status:'PASS',HTTP_checks:checks,authentication:'synthetic local adapter, not JWT/production proof',storage:'real isolated PostgreSQL',automatic_official_awards:false}));
}finally{await new Promise(r=>server.close(r));await sql(reset);assert.equal(await sql('SELECT count(*) FROM public.torneo_participantes;'),'0');}
