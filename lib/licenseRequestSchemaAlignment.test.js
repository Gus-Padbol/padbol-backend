import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {buildLicenseRequestPayload,licenseRequestPayloadHash} from '../routes/licenseRequests.js';
const migration=await readFile(new URL('../sql/migrations/20261027090000_license_request_schema_alignment.sql',import.meta.url),'utf8');
for(const shape of ['legacy','documented'])test(`public license payload persists and retries safely with ${shape} schema`,async()=>{
 const db=new PGlite();try{
 if(shape==='legacy')await db.exec(`create table solicitudes_licencia(id uuid primary key default gen_random_uuid(),nombre_club text not null,pais text not null,ciudad text not null,nombre_responsable text not null,email text not null,whatsapp text not null,cantidad_canchas integer,tipo_interes text,mensaje text,estado text default 'pendiente',created_at timestamptz default now(),deportes_canchas jsonb);insert into solicitudes_licencia(nombre_club,pais,ciudad,nombre_responsable,email,whatsapp)values('Existing','Sweden','Town','Existing person','existing@example.test','123');`);
 else await db.exec(await readFile(new URL('../docs/sql/license_requests.sql',import.meta.url),'utf8').then(s=>s.replace('REVOKE ALL ON public.solicitudes_licencia FROM anon, authenticated;','')));
 await db.exec(migration);await db.exec(migration);
 const data=buildLicenseRequestPayload({club_nombre:'Test club',responsable_nombre:'Person',email:'person@example.test',mensaje:'Starter',solicitud_inicial:true}).data;
 data.idempotency_key='a'.repeat(64);data.idempotency_payload_hash=licenseRequestPayloadHash(data);
 const fields=Object.keys(data);const sql=`insert into solicitudes_licencia(${fields.join(',')})values(${fields.map((_,i)=>'$'+(i+1)).join(',')})returning *`;
 const saved=(await db.query(sql,fields.map(k=>k==='deportes_canchas'?JSON.stringify(data[k]):data[k]))).rows[0];
 assert.equal(saved.club_nombre,'Test club');assert.equal(saved.nombre_club,'Test club');assert.equal(saved.responsable_nombre,saved.nombre_responsable);assert.equal(saved.whatsapp,null);assert.equal(saved.whatsapp_followup_consent,false);assert.equal(saved.estado,'pendiente');
 await assert.rejects(db.query(sql,fields.map(k=>k==='deportes_canchas'?JSON.stringify(data[k]):data[k])),e=>e.code==='23505');
 assert.equal((await db.query("select count(*)::int n from solicitudes_licencia where email='person@example.test'")).rows[0].n,1);
 if(shape==='legacy'){const old=(await db.query("select * from solicitudes_licencia where email='existing@example.test'")).rows[0];assert.equal(old.club_nombre,'Existing');assert.equal(old.responsable_nombre,'Existing person');assert.match(old.id,/^[a-f0-9-]{36}$/);}
 await db.query('update solicitudes_licencia set nombre_club=$1 where id=$2',['Renamed',saved.id]);assert.equal((await db.query('select club_nombre from solicitudes_licencia where id=$1',[saved.id])).rows[0].club_nombre,'Renamed');
 }finally{await db.close();}
});

test('legacy incomplete rows survive and true consent requires every metadata field', async()=>{
 const db=new PGlite();try{
 await db.exec(`create table solicitudes_licencia(id uuid primary key default gen_random_uuid(),nombre_club text,nombre_responsable text,pais text,ciudad text,email text,whatsapp text);insert into solicitudes_licencia(email)values('incomplete@example.test');`);
 await db.exec(migration);
 assert.equal((await db.query("select count(*)::int n from solicitudes_licencia where email='incomplete@example.test'")).rows[0].n,1);
 await assert.rejects(db.query("insert into solicitudes_licencia(email,whatsapp_followup_consent,whatsapp_followup_consent_at)values('consent@example.test',true,now())"),e=>e.code==='23514');
 }finally{await db.close();}
});
