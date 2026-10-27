import {test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';
test('SQL blocks format and capacity clearing with pending fixture or results and preserves all rows',async()=>{const db=new PGlite();try{
 await db.exec("create role anon;create role authenticated;create table public.torneos(id bigint primary key,tipo_torneo text,cupos_maximos integer,nombre text);create table public.partidos(id bigint primary key,torneo_id bigint references public.torneos(id),estado text,resultado jsonb);insert into torneos values(1,'knockout',8,'Initial'),(2,'round_robin',4,'No fixture');");
 await db.exec(await readFile(new URL('../sql/migrations/20261026020000_tournament_structure_frozen.sql',import.meta.url),'utf8'));
 await db.exec("update torneos set tipo_torneo='round_robin',cupos_maximos=12 where id=1;insert into partidos values(10,1,'pendiente',null);");
 for(const query of ["update torneos set tipo_torneo='knockout' where id=1","update torneos set cupos_maximos=null where id=1","update torneos set cupos_maximos=16 where id=1"])await assert.rejects(db.exec(query),/TORNEO_STRUCTURE_FROZEN/);
 await db.exec("update torneos set nombre='Renamed',tipo_torneo='round_robin',cupos_maximos=12 where id=1;update partidos set estado='finalizado',resultado='{\"sets_a\":2,\"sets_b\":0}' where id=10;");
 await assert.rejects(db.exec("update torneos set tipo_torneo='knockout' where id=1"),/TORNEO_STRUCTURE_FROZEN/);
 assert.deepEqual((await db.query('select tipo_torneo,cupos_maximos,nombre from torneos where id=1')).rows,[{tipo_torneo:'round_robin',cupos_maximos:12,nombre:'Renamed'}]);assert.equal((await db.query('select count(*) from partidos')).rows[0].count,1);
 await db.exec('begin;update torneos set cupos_maximos=6 where id=2;rollback;');assert.equal((await db.query('select cupos_maximos from torneos where id=2')).rows[0].cupos_maximos,4);
 }finally{await db.close();}});
