import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {PGlite} from '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/node_modules/@electric-sql/pglite/dist/index.js';
import {rejectPendingSede} from '../lib/sedePendingRejection.js';
const source=await fs.readFile(new URL('./commercialRelease.js',import.meta.url),'utf8');
const fixture=await fs.readFile(new URL('../lib/fixtures/sedeApprovalFixture.sql',import.meta.url),'utf8');
test('legacy rejection confirms persisted state and reports notification review without unsafe replay',async()=>{
 for(const mode of ['lookup_error','lookup_throw','transport_uncertain','accepted','no_phone']){
  const db=new PGlite();try{
   // No recovery migration/outbox: the legacy path must work with its flag off.
   await db.exec(fixture);await db.exec('ALTER TABLE sedes_pendientes ADD COLUMN motivo_rechazo text');
   let sends=0;
   const supabase={from(table){
    if(table==='jugadores_perfil')return {select(){return this},eq(){return this},async maybeSingle(){if(mode==='lookup_throw')throw Error('synthetic lookup failure');return mode==='lookup_error'?{data:null,error:{message:'synthetic lookup error'}}:{data:mode==='no_phone'?null:{whatsapp:'+540000000000'},error:null};}};
    assert.equal(table,'sedes_pendientes');let update=null;const filters={};return {select(){return this},eq(k,v){filters[k]=v;return this},update(value){update=value;return this},async maybeSingle(){const r=update?await db.query('UPDATE sedes_pendientes SET estado=$2,motivo_rechazo=$3 WHERE id=$1 AND estado=$4 RETURNING id',[filters.id,update.estado,update.motivo_rechazo,filters.estado]):await db.query('SELECT * FROM sedes_pendientes WHERE id=$1',[filters.id]);return {data:r.rows[0]||null,error:null};}};
   }};
   const lookupStart=source.indexOf('async function fetchJugadorWhatsappPorEmail('),lookupEnd=source.indexOf('\nasync function upsertUserRoleAdminClub',lookupStart);
   const lookup=vm.runInNewContext('('+source.slice(lookupStart,lookupEnd).trim()+')',{supabase});
   if(mode.startsWith('lookup_'))assert.equal(await lookup('manager@example.invalid'),null); // unchanged tolerant legacy default
   let handler;const start=source.indexOf("app.post('/api/admin/sedes-pendientes/:id/rechazar'"),end=source.indexOf('\nregisterAdminOrganizationsRoutes',start);
   vm.runInNewContext(source.slice(start,end),{app:{post(_path,fn){handler=fn}},supabase,
    authUserFromBearer:async()=>({id:'11111111-1111-4111-8111-111111111111',email:'owner@example.invalid'}),
    fetchUserRoleRow:async()=>({role:'super_admin'}),isSuperAdminApi:(_email,role)=>role==='super_admin',rejectPendingSede,
    fetchJugadorWhatsappPorEmail:lookup,sendTwilioWhatsAppBodyToRaw:async()=>{sends++;if(mode==='transport_uncertain')throw Error('synthetic lost acknowledgement');return {sid:'synthetic-sid'};},console:{error(){}}});
   const call=async()=>{const res={statusCode:200,status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};await handler({params:{id:'7'},body:{motivo:'Synthetic rejection'}},res);return res;};
   const response=await call();assert.equal(response.statusCode,200,mode);assert.equal(response.body.ok,true);
   const pending=['lookup_error','lookup_throw','transport_uncertain'].includes(mode);
   assert.equal(response.body.notifications_pending,pending,mode);assert.equal(response.body.notification_status,pending?'needs_review':mode==='accepted'?'accepted':'skipped');
   assert.equal((await db.query('SELECT estado FROM sedes_pendientes WHERE id=7')).rows[0].estado,'rechazada');
   const before=sends;assert.equal((await call()).statusCode,400);assert.equal(sends,before,'repeating rejection must not repeat a possibly accepted notice');
   assert.equal((await db.query("SELECT to_regclass('public.sede_approval_outbox') AS x")).rows[0].x,null);
  }finally{await db.close();}
 }
});
