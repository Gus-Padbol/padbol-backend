import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { mountTorneoInteresRoutes } from './torneoInteres.js';
import { mountListaEsperaGeneralRoutes } from './listaEsperaGeneral.js';

function adapter(pg) {
  return { from(table) { let columns='*',order='',limit=100; const where=[],args=[];
    const query = { select(value) { columns=value;return query; }, eq(k,v){ args.push(v);where.push(`${k}=$${args.length}`);return query; },
      gt(k,v){args.push(v);where.push(`${k}>$${args.length}`);return query;}, in(k,v){args.push(v);where.push(`${k}=ANY($${args.length}::uuid[])`);return query;},
      order(k){order=` ORDER BY ${k}`;return query;},limit(n){limit=Math.min(1,n);return query;},
      then(resolve,reject){return pg.query(`SELECT ${columns} FROM ${table} WHERE ${where.join(' AND ')}${order} LIMIT ${limit}`,args).then(r=>({data:r.rows,error:null}),error=>({data:null,error})).then(resolve,reject);} };
    return query;
  } };
}
test('HTTP routes for synthetic venue and sport interests honor venue role and page all rows', async()=>{
  const pg=new PGlite();let server;
  try {
    await pg.exec(`CREATE TABLE torneo_interes(id uuid PRIMARY KEY,sede_id integer,user_id uuid,deporte text,created_at timestamptz);
    CREATE TABLE lista_espera_general(id bigint PRIMARY KEY,sede_id integer,user_id uuid,deporte text,created_at timestamptz);
    CREATE TABLE jugadores_perfil(user_id uuid PRIMARY KEY,nombre text,apellido text,apodo text,username text,email text,foto_url text);
    INSERT INTO jugadores_perfil VALUES ('00000000-0000-0000-0000-000000000001','Jugador A',null,null,null,'a@example.test',null),('00000000-0000-0000-0000-000000000002','Jugador B',null,null,null,'b@example.test',null);
    INSERT INTO torneo_interes VALUES ('10000000-0000-0000-0000-000000000001',7,'00000000-0000-0000-0000-000000000001',null,now()),('10000000-0000-0000-0000-000000000002',7,'00000000-0000-0000-0000-000000000002',null,now());
    INSERT INTO lista_espera_general VALUES (1,7,'00000000-0000-0000-0000-000000000001','padbol',now()),(2,8,'00000000-0000-0000-0000-000000000002','padbol',now());`);
    const app=express(); const deps={supabaseAdmin:adapter(pg),getAuthenticatedUser:async(req)=>req.headers.authorization?{user:{id:'admin',email:'admin@example.test'}}:{user:null,status:401,error:'Unauthorized'},fetchUserRoleRowForAuthUser:async()=>({role:'admin_club',sede_id:7})};
    mountTorneoInteresRoutes(app,deps);mountListaEsperaGeneralRoutes(app,deps);
    server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
    const base=`http://127.0.0.1:${server.address().port}`;const auth={headers:{Authorization:'Bearer synthetic'}};
    const venue=await fetch(`${base}/api/admin/sedes/7/torneo-interes`,auth); const va=await venue.json();
    const sport=await fetch(`${base}/api/admin/lista-espera-general/7`,auth); const sp=await sport.json();
    assert.equal(venue.status,200);assert.equal(va.interesados.length,2);assert.equal(sp.lista.length,1);assert.equal(sp.lista[0].nombre,'Jugador A');
    assert.equal((await fetch(`${base}/api/admin/sedes/8/torneo-interes`,auth)).status,403);
    assert.equal((await fetch(`${base}/api/admin/lista-espera-general/7`)).status,401);
  } finally { if(server) await new Promise(r=>server.close(r));await pg.close(); }
});
