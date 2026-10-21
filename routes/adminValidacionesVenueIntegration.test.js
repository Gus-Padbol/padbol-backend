import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { mountAdminValidationAndChannelsRoutes } from './adminValidationAndChannels.js';

function adapter(pg) {
  return {from(table) {let columns='*',order='',limit=100,updates=null;const where=[],args=[];
    const q={select(c){columns=c;return q},update(v){updates=v;return q},eq(k,v){args.push(v);where.push(`${k}=$${args.length}`);return q},gt(k,v){args.push(v);where.push(`${k}>$${args.length}`);return q},order(k){order=` ORDER BY ${k}`;return q},limit(n){limit=n;return q},
      async maybeSingle(){const set=Object.entries(updates).map(([k,v])=>{args.push(v);return `${k}=$${args.length}`}).join(',');try {const r=await pg.query(`UPDATE ${table} SET ${set} WHERE ${where.join(' AND ')} RETURNING ${columns}`,args);return {data:r.rows[0]??null,error:null}}catch(error){return {data:null,error}}},
      then(resolve,reject){return pg.query(`SELECT ${columns} FROM ${table} WHERE ${where.join(' AND ')}${order} LIMIT ${limit}`,args).then(r=>({data:r.rows,error:null}),error=>({data:null,error})).then(resolve,reject)}};return q;}};
}
test('validación por sede protege lecturas y escrituras con datos PostgreSQL sintéticos',async()=>{
 const pg=new PGlite();let server;
 try {await pg.exec(`CREATE TABLE jugadores_perfil(id bigint primary key,email text,nombre text,apellido text,alias text,user_id uuid,pais text,nivel text,genero text,categoria_validada boolean,pendiente_validacion boolean,sede_id integer);
 INSERT INTO jugadores_perfil(id,email,pendiente_validacion,sede_id) VALUES (1,'own@example.test',true,7),(2,'other@example.test',true,8),(3,'unassigned@example.test',true,null);`);
 const app=express();app.use(express.json());mountAdminValidationAndChannelsRoutes(app,{supabaseAdmin:adapter(pg),getAuthenticatedUser:async req=>req.headers.authorization?{user:{id:'synthetic'}}:{user:null,status:401},fetchUserRoleRowForAuthUser:async()=>({role:'admin_club',sede_id:7})});
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});const base=`http://127.0.0.1:${server.address().port}`;const headers={Authorization:'Bearer synthetic','Content-Type':'application/json'};
 const list=await fetch(`${base}/api/admin/validaciones`,{headers});assert.deepEqual((await list.json()).validaciones.map(x=>x.id),[1]);
 const patch=id=>fetch(`${base}/api/admin/validaciones/perfil/${id}`,{method:'PATCH',headers,body:JSON.stringify({accion:'aprobar'})});
 assert.equal((await patch(2)).status,409);assert.equal((await patch(3)).status,409);assert.equal((await patch(1)).status,200);
 assert.deepEqual((await pg.query('SELECT id,pendiente_validacion FROM jugadores_perfil ORDER BY id')).rows,[{id:1,pendiente_validacion:false},{id:2,pendiente_validacion:true},{id:3,pendiente_validacion:true}]);
 assert.equal((await fetch(`${base}/api/admin/validaciones`)).status,401);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await pg.close()}
});
