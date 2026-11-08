import test from 'node:test'; import assert from 'node:assert/strict';
import express from 'express'; import {createServer} from 'node:http'; import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {isHandleTaken} from './publicAliasNamespace.js';
import {mountAliasAvailabilityRoute} from './publicAliasAvailability.js';

const COLS='id,user_id,alias,username,apodo';
async function pgAdapter(now) {
  const pg=new PGlite();
  await pg.exec(`create table jugadores_perfil(id serial primary key,user_id text,alias text,username text,apodo text);
  insert into jugadores_perfil(user_id,alias,username,apodo) values
   ('OWN','nico','nico_web','Nico'),('OTHER','tomado','otro_user','Otro'),('PCT','a%b','x_y','z"q');`);
  const allowed=new Set(['alias','username','apodo']);
  return { pg, sb:{ from(){ return {
    select(){return this},
    filter(field,operator,pattern){ if(operator!=='imatch'||!allowed.has(field)) throw new Error('field'); this._q={field,pattern}; return this; },
    async limit(n){ const {field,pattern}=this._q; const r=await pg.query(`select ${COLS} from jugadores_perfil where ${field} ~* $1 limit $2`,[pattern,n]); return {data:r.rows,error:null}; },
  }; } } };
}
async function appWith(pg) {
  const app=express();
  mountAliasAvailabilityRoute(app,{supabaseAdmin:pg.sb, authUserFromBearer:async(req)=>{const t=String(req.headers.authorization||'').replace(/^Bearer /,''); return t==='own'?{id:'OWN'}:t==='other'?{id:'OTHER'}:t==='pct'?{id:'PCT'}:null;}});
  const s=createServer(app); s.listen(0,'127.0.0.1'); await once(s,'listening');
  return {base:`http://127.0.0.1:${s.address().port}`, close:()=>s.close(), pg:pg.pg};
}
const get=(base,q,token)=>fetch(`${base}/api/registro/alias-disponible?alias=${encodeURIComponent(q)}`,{headers:token?{authorization:`Bearer ${token}`}:{}});

test('handler real + regex Postgres: propio UUID disponible, ajeno tomado, case-insensitive',async()=>{
  const a=await appWith(await pgAdapter()); try{
    assert.equal((await (await get(a.base,'@NiCo','own')).json()).available,true);
    assert.equal((await (await get(a.base,'NICO','other')).json()).available,false);
    assert.equal((await (await get(a.base,'tomado')).json()).available,false);
  } finally {a.close(); await a.pg.close();}
});
test('handler real: % y _ no son comodin; comilla/backslash literal',async()=>{
  const a=await appWith(await pgAdapter()); try{
    assert.equal((await (await get(a.base,'aXb')).json()).available,true);
    assert.equal((await (await get(a.base,'a%b')).json()).available,false);
    assert.equal((await (await get(a.base,'a%b','pct')).json()).available,true);
  } finally {a.close(); await a.pg.close();}
});
test('handler real: Bearer malformado => 401, no disponible',async()=>{
  const a=await appWith(await pgAdapter()); try{
    const r=await get(a.base,'nico','malformed'); assert.equal(r.status,401);
  } finally {a.close(); await a.pg.close();}
});

test('legacy whitespace/@ and regex literals use actual PostgreSQL rows',async()=>{
  const fixture=await pgAdapter(); const a=await appWith(fixture);
  try {
    for(const field of ['alias','username','apodo']) {
      for(const handle of ['nico','a.b','a+b','a*b','a?b','a^b','a$b','a(b)','a[b]','a{b}','a|b','a\\b','a%b','a_b','a"b','a/b']) {
        for(const wrap of [v=>v,v=>'@'+v,v=>'  @@'+v+'  ',v=>'\t@'+v+'\t',v=>'\u00a0@'+v+'\u00a0']) {
          await fixture.pg.exec('truncate jugadores_perfil');
          await fixture.pg.query(`insert into jugadores_perfil(user_id,${field}) values($1,$2)`,['OWN',wrap(handle)]);
          assert.equal((await isHandleTaken({supabaseAdmin:fixture.sb,handle,userId:'OWN'})).taken,false,field+handle+' own');
          assert.equal((await isHandleTaken({supabaseAdmin:fixture.sb,handle,userId:'OTHER'})).taken,true,field+handle+' other');
        }
      }
    }
    await fixture.pg.exec('truncate jugadores_perfil');
    await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values(null,$1)',[' @nico ']);
    assert.equal((await (await get(a.base,'nico','own')).json()).available,false);
    await fixture.pg.exec('truncate jugadores_perfil');
    await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values($1,$2)',['OWN','@ nico']);
    assert.equal((await (await get(a.base,'nico')).json()).available,true,'no whitespace after @');
  } finally {a.close();await fixture.pg.close();}
});

test('installed Supabase SDK encodes imatch pattern without network',async()=>{
  const {createClient}=await import('@supabase/supabase-js');
  const {handleMatchPattern}=await import('./publicAliasNamespace.js');
  const urls=[];
  const sb=createClient('https://fixture.invalid','fixture-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async input=>{urls.push(new URL(String(input)));return new Response('[]',{status:200,headers:{'content-type':'application/json'}})}}});
  const handle='a"b%_\\[x]/c';
  const result=await isHandleTaken({supabaseAdmin:sb,handle});
  assert.equal(result.taken,false);assert.equal(urls.length,3);
  for(let i=0;i<3;i++) {
    assert.equal(urls[i].searchParams.get(['alias','username','apodo'][i]),'imatch.'+handleMatchPattern(handle));
    assert.equal(urls[i].searchParams.get('limit'),'5');
    assert.equal(urls[i].searchParams.has('or'),false);
  }
});

test('SQL matching equals JS trim whitespace without NEL/zero-width limit pollution',async()=>{
 const fixture=await pgAdapter();
 try {
  const points=[9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
  for(const point of points) {
   const ws=String.fromCodePoint(point); const stored=ws+'@@nico'+ws;
   assert.equal(stored.trim().replace(/^@+/, '').toLowerCase(),'nico');
   await fixture.pg.exec('truncate jugadores_perfil');
   await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values($1,$2)',['OTHER',stored]);
   assert.equal((await isHandleTaken({supabaseAdmin:fixture.sb,handle:'nico',userId:'OWN'})).taken,true,'U+'+point.toString(16));
  }
  for(const bad of ['\u0085','\u200b','@ ']) {
   await fixture.pg.exec('truncate jugadores_perfil');
   await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values($1,$2)',['OTHER',bad+'nico']);
   assert.equal((await isHandleTaken({supabaseAdmin:fixture.sb,handle:'nico',userId:'OWN'})).taken,false);
  }
  await fixture.pg.exec('truncate jugadores_perfil');
  for(let i=0;i<5;i++) await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values($1,$2)',['OTHER','\u0085nico']);
  await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values($1,$2)',['OTHER',' @nico ']);
  assert.equal((await isHandleTaken({supabaseAdmin:fixture.sb,handle:'nico',userId:'OWN'})).taken,true,'five false rows cannot hide real match');
 }finally{await fixture.pg.close()}
});

test('PostgreSQL case folding is authoritative even when JS lowercasing differs',async()=>{
 const fixture=await pgAdapter();
 try {
  for(const [stored,handle] of [['ſame','same'],['Key','key']]) {
   await fixture.pg.exec('truncate jugadores_perfil');
   await fixture.pg.query('insert into jugadores_perfil(user_id,alias) values($1,$2)',['OTHER',stored]);
   const sql=await fixture.pg.query('select $1::text ~* $2::text as matched',[stored,'^'+handle+'$']);
   assert.equal((await isHandleTaken({supabaseAdmin:fixture.sb,handle,userId:'OWN'})).taken,sql.rows[0].matched);
  }
 }finally{await fixture.pg.close()}
});
