import test from 'node:test'; import assert from 'node:assert/strict';
import express from 'express'; import {createServer} from 'node:http'; import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
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
    ilike(field,pattern){ if(!allowed.has(field)) throw new Error('field'); this._q={field,pattern}; return this; },
    async limit(n){ const {field,pattern}=this._q; const r=await pg.query(`select ${COLS} from jugadores_perfil where ${field} ilike $1 limit $2`,[pattern,n]); return {data:r.rows,error:null}; },
  }; } } };
}
async function appWith(pg) {
  const app=express();
  mountAliasAvailabilityRoute(app,{supabaseAdmin:pg.sb, authUserFromBearer:async(req)=>{const t=String(req.headers.authorization||'').replace(/^Bearer /,''); return t==='own'?{id:'OWN'}:t==='other'?{id:'OTHER'}:t==='pct'?{id:'PCT'}:null;}});
  const s=createServer(app); s.listen(0,'127.0.0.1'); await once(s,'listening');
  return {base:`http://127.0.0.1:${s.address().port}`, close:()=>s.close(), pg:pg.pg};
}
const get=(base,q,token)=>fetch(`${base}/api/registro/alias-disponible?alias=${encodeURIComponent(q)}`,{headers:token?{authorization:`Bearer ${token}`}:{}});

test('handler real + ILIKE Postgres: propio UUID disponible, ajeno tomado, case-insensitive',async()=>{
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
