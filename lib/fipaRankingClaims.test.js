import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {createFipaClaimStore,validateInvitation,validateClaimToken,assertClaimAccount} from './fipaRankingClaims.js';
const uid='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',key='a'.repeat(64);
const user={id:uid,email:'player@example.test',email_confirmed_at:'2026-10-01'};
const body={destino_tipo:'email',destino_valor:user.email,identidad_verificada:true,justificacion:'Identidad confirmada con la delegación nacional.'};
test('requiere identidad comprobada, correo preciso y no admite invitación genérica por WhatsApp',()=>{
 assert.throws(()=>validateInvitation({...body,identidad_verificada:false}));assert.throws(()=>validateInvitation({...body,destino_tipo:'whatsapp'}));assert.throws(()=>validateInvitation({...body,justificacion:'ok'}));assert.equal(validateInvitation({...body,destino_valor:' PLAYER@example.test '}).email,user.email);
 assert.throws(()=>validateClaimToken('guess'));assert.throws(()=>assertClaimAccount({email:user.email},{...user,email_confirmed_at:null}));assert.throws(()=>assertClaimAccount({email:user.email},{...user,email:'other@example.test'}));
});
test('SQL real: invitación única, cuenta confirmada, no duplicación de identidad ni uso repetido, auditoría atómica y tablas privadas',async()=>{
 const db=new PGlite();try{
 await db.exec(`create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${uid}'),('${other}');create role anon;create role authenticated;create role service_role;`);
 const sql=await readFile(new URL('../sql/20261029163000_fipa_ranking_claims.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 const query=async(s,v)=>{const r=await db.query(s,v);return {...r,rowCount:r.rows.length||r.affectedRows||0}};const pool={query,connect:async()=>({query,release(){}})};const store=createFipaClaimStore(pool);
 const one=await store.prepare({source_key:key,nombre_completo:'Official Player'},user,body);assert.equal(one.token.length,43);
 const two=await store.prepare({source_key:key,nombre_completo:'Official Player'},user,body);
 await assert.rejects(store.validate(one.token));assert.equal((await store.validate(two.token)).player_name,'Official Player');
 await assert.rejects(store.accept(two.token,{...user,id:other,email:'wrong@example.test'}));assert.equal((await store.links()).length,0);
 await assert.rejects(store.accept(two.token,{...user,email_confirmed_at:null}));
 assert.equal(await store.accept(two.token,user),key);assert.deepEqual(await store.links(),[{source_key:key,user_id:uid}]);
 await assert.rejects(store.accept(two.token,user));await assert.rejects(store.prepare({source_key:key,nombre_completo:'Official Player'},user,body));
 const next=await store.prepare({source_key:'b'.repeat(64),nombre_completo:'Different Player'},user,body);await assert.rejects(store.accept(next.token,user));
 assert.equal((await db.query("select count(*)::int n from fipa_ranking_claim_audit where action='accept'")).rows[0].n,1);
 const privileges=await db.query("select has_table_privilege('authenticated','public.fipa_ranking_claim_invites','select') allowed");assert.equal(privileges.rows[0].allowed,false);
 const rls=await db.query("select relrowsecurity from pg_class where relname='fipa_ranking_links'");assert.equal(rls.rows[0].relrowsecurity,true);
 assert.equal(await store.operator(uid),false);
 }finally{await db.close()}
});

test('autoservicio: solicitar no vincula; solo revisión comprobada vincula una vez; rechazo y privacidad',async()=>{
 const db=new PGlite();try{
 await db.exec(`create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${uid}'),('${other}');create role anon;create role authenticated;create role service_role;`);
 for(const file of ['20261029163000_fipa_ranking_claims.sql','20261029190000_fipa_selfservice.sql']){const sql=await readFile(new URL('../sql/'+file,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);}
 const query=async(s,v)=>{const r=await db.query(s,v);return {...r,rowCount:r.rows.length||r.affectedRows||0}};const store=createFipaClaimStore({query,connect:async()=>({query,release(){}})});
 const player={source_key:key};
 await assert.rejects(store.request(player,{...user,email_confirmed_at:null},true));await assert.rejects(store.request(player,user,false));
 const request=await store.request(player,user,true);assert.equal(request.state,'pending');assert.equal((await store.links()).length,0);
 assert.equal((await store.request(player,user,true)).id,request.id);
 await assert.rejects(store.request({source_key:'b'.repeat(64)},user,true));
 const rival=await store.request(player,{...user,id:other},true);
 await assert.rejects(store.review(request.id,{id:other},'approved','ok'));
 await store.review(request.id,{id:other},'approved','Identidad verificada con el responsable de la delegación.');
 assert.deepEqual(await store.links(),[{source_key:key,user_id:uid}]);
 await assert.rejects(store.review(request.id,{id:other},'approved','Identidad verificada nuevamente.'));
 await assert.rejects(store.review(rival.id,{id:other},'approved','Otro usuario intenta el mismo perfil.'));
 await store.review(rival.id,{id:other},'rejected','El perfil corresponde al jugador ya verificado.');
 assert.equal((await store.requests(other))[0].state,'rejected');assert.equal((await store.requests(uid)).length,1);
 assert.equal((await db.query("select count(*)::int n from fipa_ranking_claim_audit where action='approved'")).rows[0].n,1);
 assert.equal((await db.query("select has_table_privilege('authenticated','public.fipa_ranking_requests','select') allowed")).rows[0].allowed,false);
 }finally{await db.close()}
});
