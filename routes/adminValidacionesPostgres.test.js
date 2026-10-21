import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mountAdminValidationAndChannelsRoutes } from './adminValidationAndChannels.js';

function adapter(pg) {
  return { from(table) {
    const clauses=[],args=[]; let columns='*', ordering='',limit=1;
    const q={select(s){columns=s;return q},eq(k,v){args.push(v);clauses.push(`${k} = $${args.length}`);return q},
      is(k){clauses.push(`${k} IS NULL`);return q},not(k){clauses.push(`${k} IS NOT NULL`);return q},
      gt(k,v){args.push(v);clauses.push(`${k} > $${args.length}`);return q},order(k){ordering=` ORDER BY ${k}`;return q},
      limit(n){limit=Math.min(1,n);return q},then(resolve,reject){return pg.query(`SELECT ${columns} FROM ${table} WHERE ${clauses.join(' AND ')}${ordering} LIMIT ${limit}`,args).then(r=>({data:r.rows,error:null}),error=>({data:null,error})).then(resolve,reject)}};return q;
  } };
}
async function call(handler){const res={code:200,status(c){this.code=c;return this},json(v){this.body=v;return this}};await handler({},res);return res;}
test('PostgreSQL pagina por UUID sin columna id y no oculta perfiles sin identidad',async()=>{
  const pg=new PGlite();
  try {
    await pg.exec(`CREATE TABLE jugadores_perfil (user_id UUID UNIQUE, email text NOT NULL, nombre text, apellido text, alias text, pais text, nivel text, genero text, pendiente_validacion boolean, categoria_validada boolean);
    INSERT INTO jugadores_perfil(user_id,email,pendiente_validacion,categoria_validada) VALUES
    ('00000000-0000-0000-0000-000000000001','one@example.test',true,false),
    ('00000000-0000-0000-0000-000000000002','two@example.test',true,true),
    ('00000000-0000-0000-0000-000000000003','three@example.test',true,false);`);
    const handlers={};const app=Object.fromEntries(['get','post','patch'].map(m=>[m,(p,h)=>handlers[`${m} ${p}`]=h]));
    mountAdminValidationAndChannelsRoutes(app,{supabaseAdmin:adapter(pg),getAuthenticatedUser:async()=>({user:{id:'admin',email:'admin@example.test'}}),fetchUserRoleRowForAuthUser:async()=>({role:'super_admin'}),env:{}});
    const handler=handlers['get /api/admin/validaciones'];
    const good=await call(handler);assert.equal(good.code,200);assert.deepEqual(good.body.validaciones.map(r=>r.email),['one@example.test','three@example.test']);
    await pg.exec("INSERT INTO jugadores_perfil(email,pendiente_validacion) VALUES ('legacy@example.test', true)");
    const legacy=await call(handler);assert.equal(legacy.code,503);assert.equal(legacy.body.validaciones,undefined);
    await pg.exec("DELETE FROM jugadores_perfil WHERE user_id IS NULL; ALTER TABLE jugadores_perfil DROP COLUMN categoria_validada");
    const missing=await call(handler);assert.equal(missing.code,500);assert.equal(missing.body.validaciones,undefined);
  } finally { await pg.close(); }
});
