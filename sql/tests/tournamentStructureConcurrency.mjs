import {execFileSync} from 'node:child_process';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import pg from 'pg';
const dir=mkdtempSync(join(tmpdir(),'padbol-structure-pg-')),bin=process.env.PG_BIN||'/opt/homebrew/opt/postgresql@17/bin/',port=55439;
let a,b;
try{
 execFileSync(bin+'initdb',['-D',dir,'-A','trust','-U','postgres'],{stdio:'ignore'});execFileSync(bin+'pg_ctl',['-D',dir,'-l',join(dir,'server.log'),'-o',`-p ${port} -h 127.0.0.1 -k ${dir}`,'-w','start'],{stdio:'ignore'});
 a=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});b=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await a.connect();await b.connect();
 await a.query("create role anon;create role authenticated;create table public.torneos(id bigint primary key,tipo_torneo text,cupos_maximos integer);create table public.partidos(id bigint primary key,torneo_id bigint references public.torneos(id));insert into torneos values(1,'knockout',8);");
 await a.query(readFileSync(new URL('../migrations/20261026020000_tournament_structure_frozen.sql',import.meta.url),'utf8'));
 await a.query('begin;insert into partidos values(1,1)');let finished=false;const edit=b.query("update torneos set cupos_maximos=null where id=1").then(()=>{finished=true;return null;},e=>{finished=true;return e;});await new Promise(r=>setTimeout(r,100));assert.equal(finished,false);await a.query('commit');assert.match((await edit).message,/TORNEO_STRUCTURE_FROZEN/);assert.equal((await a.query('select cupos_maximos from torneos')).rows[0].cupos_maximos,8);
 console.log('PASS real PostgreSQL: concurrent fixture insert serializes and blocks destructive capacity clear; fixture retained.');
}finally{await a?.end();await b?.end();try{execFileSync(bin+'pg_ctl',['-D',dir,'-m','immediate','-w','stop'],{stdio:'ignore'});}catch{}rmSync(dir,{recursive:true,force:true});}
