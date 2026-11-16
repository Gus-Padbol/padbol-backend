#!/usr/bin/env node
/** Local-only Nations postmatch demo. Requires a fresh dedicated DB; never drops tables. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import {createServer} from 'node:http';
import {mountNationsPostmatchRoutes} from '../lib/torneos/nationsPostmatchRoutes.js';
import {buildNationsPostmatchScenario} from '../lib/torneos/nationsPostmatchScenario.js';
import {enqueueNationsPostmatchForPartido,processOneNationsPostmatchJob,anonymizeObserved,buildNationsPostmatchProviderRequest} from '../lib/torneos/nationsPostmatchAi.js';

const args=new Set(process.argv.slice(2));
const OUTDIR=path.resolve(process.env.NATIONS_POSTMATCH_OUTDIR||'/Users/padbol2022/Documents/Codex/2026-11-16/IA-SIMULACION-GUS');
fs.mkdirSync(OUTDIR,{recursive:true,mode:0o700});
const emit=(value)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
console.log=()=>{};
const real=args.has('--real-provider');
const exportRequest=args.has('--export-provider-request');
const replyArg=[...args].find(arg=>arg.startsWith('--provider-reply-file='));
if(exportRequest){
 const scenario=buildNationsPostmatchScenario();
 const request=buildNationsPostmatchProviderRequest(scenario);
 const out=path.resolve(process.env.NATIONS_POSTMATCH_REQUEST||path.join(OUTDIR,'nations-postmatch-provider-request.json'));
 fs.writeFileSync(out,JSON.stringify(request,null,2),{mode:0o600});
 emit({status:'request-exported',requestHash:request.requestHash,file:out,providerCalls:0});
 process.exit(0);
}
const DSN=process.env.NATIONS_POSTMATCH_PG_URL;
if(!DSN)throw new Error('Set NATIONS_POSTMATCH_PG_URL to the dedicated local DB.');
const url=new URL(DSN);
const dbName=decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)||'');
if(dbName!=='nations_postmatch_ai_demo')throw new Error('REFUSE_DB_NAME');
const host=url.searchParams.get('host')||url.hostname; if(!(host.startsWith('/')&&fs.existsSync(host)||['127.0.0.1','localhost'].includes(host)))throw new Error('REFUSE_NON_LOCAL_DB');
const pool=new pg.Pool({connectionString:DSN,max:2});
const mode=real?'real':replyArg?'reply':'stub';
const hash=(v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const facts=buildNationsPostmatchScenario();
const factsHash=hash(facts);
const expectedRequestHash=(real||replyArg)?buildNationsPostmatchProviderRequest(facts).requestHash:null;
const cache=path.resolve(process.env.NATIONS_POSTMATCH_CACHE||path.join(OUTDIR,`nations-postmatch-demo-${mode}.json`));
const claim=path.resolve(process.env.NATIONS_POSTMATCH_CLAIM||path.join(OUTDIR,`nations-postmatch-demo-${mode}.claim`));
const receiptPath=path.resolve(process.env.NATIONS_POSTMATCH_RECEIPT||path.join(OUTDIR,`nations-postmatch-demo-${mode}-receipt.json`));
if(fs.existsSync(cache)){
 const cached=JSON.parse(fs.readFileSync(cache,'utf8'));
 const expectedProvider=real?'real':replyArg?'reply-file':'stub';
 if(cached.mode!==mode||cached.factsHash!==factsHash||cached.provider!==expectedProvider||(expectedRequestHash&&cached.requestHash!==expectedRequestHash))throw new Error('DEMO_CACHE_MISMATCH');
 emit({status:'cached',mode,factsHash,cache,providerCalls:0});await pool.end();process.exit(0);
}let replyPayload=null;
if(replyArg){
 const file=replyArg.split('=').slice(1).join('=');
 replyPayload=JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
 const request=buildNationsPostmatchProviderRequest(facts);
 if(replyPayload.requestHash!==request.requestHash)throw new Error('PROVIDER_REPLY_HASH_MISMATCH');
}

// Exclusive claim before any provider/network work; timeout/uncertain preserves it.
try{fs.writeFileSync(claim,JSON.stringify({mode,factsHash,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});}catch(error){if(error.code==='EEXIST')throw new Error('DEMO_ALREADY_CLAIMED_RETAINED');throw error;}
// Fail closed: never drop or reuse tables. Runner must provide a fresh database.
const existing=await pool.query("SELECT to_regclass('public.torneos') AS t, to_regclass('nations_postmatch_ai.jobs') AS j, to_regclass('nations_marker_private.nations_marker_match') AS m");
if(existing.rows[0]?.t||existing.rows[0]?.j||existing.rows[0]?.m)throw new Error('DEMO_DB_NOT_FRESH');
await pool.query(`CREATE SCHEMA nations_postmatch_ai; CREATE SCHEMA nations_marker_private;
CREATE TABLE torneos(id bigint PRIMARY KEY,sede_id bigint,modalidad_plantel text,deporte text,plan_nations jsonb,es_prueba boolean DEFAULT true);
CREATE TABLE partidos(id bigint PRIMARY KEY,torneo_id bigint,equipo_a_id bigint,equipo_b_id bigint); INSERT INTO partidos VALUES(90016,57,101,102);
CREATE TABLE equipos(id bigint PRIMARY KEY,torneo_id bigint,creador_id uuid,jugadores jsonb,inscripcion_estado text);
CREATE TABLE torneo_partido_alineaciones(torneo_id bigint,partido_id bigint,equipo_id bigint,iniciales jsonb,suplentes jsonb,revision bigint);
CREATE TABLE scoreboard_partidos(id uuid PRIMARY KEY,partido_torneo_id bigint,sede_id bigint,torneo_id bigint,cancha text,estado text,cronometro_inicio timestamptz,cronometro_pausado boolean,cronometro_segundos integer,updated_at timestamptz,score_a integer,score_b integer,games_a integer,games_b integer,sets_a integer,sets_b integer,historial_sets jsonb DEFAULT '[]',equipo_a_nombre text,equipo_b_nombre text,equipo_a_jugadores jsonb,equipo_b_jugadores jsonb);
CREATE TABLE scoreboard_historial_puntos(id bigserial PRIMARY KEY,partido_id uuid,timestamp timestamptz,equipo text);
CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text); INSERT INTO sedes VALUES(9,'Synthetic');
CREATE TABLE canchas(id bigint,sede_id bigint,nombre text,orden integer);
INSERT INTO torneos VALUES(57,9,'selecciones','padbol','{"roster_publication_approved":true}',true);
CREATE TABLE nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,revision integer,states jsonb,tracking_status text,receipts jsonb,games_ledger jsonb);
CREATE TABLE nations_marker_private.games_finalization_intents(scoreboard_id uuid,status text,occurred_at timestamptz);`);
await pool.query(await readFile(new URL('../sql/migrations/20261115_nations_postmatch_ai.sql',import.meta.url),'utf8'));
const U=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const mapId=(old)=>String(old).startsWith('a')?U(100+Number(String(old).slice(1))):String(old).startsWith('b')?U(200+Number(String(old).slice(1))):old;
const A=facts.context.teams['101'].players.map(p=>({...p,id:mapId(p.id)}));
const B=facts.context.teams['102'].players.map(p=>({...p,id:mapId(p.id)}));
const boardId=U(1);
for(const [team,list] of [[101,A],[102,B]]){
 await pool.query('INSERT INTO equipos VALUES($1,57,NULL,$2,$3)',[team,JSON.stringify(list.map(p=>({user_id:p.id,nombre:p.name,estado:'confirmado'}))),'confirmado']);
 await pool.query('INSERT INTO torneo_partido_alineaciones VALUES(57,90016,$1,$2,$3,1)',[team,JSON.stringify(list.slice(0,2).map(p=>p.id)),JSON.stringify(list.slice(2).map(p=>p.id))]);
}
const mapState=(state)=>({...state,active:state.active.map(mapId),roster:state.roster.map(mapId),lineup:{iniciales:state.lineup.iniciales.map(mapId),suplentes:state.lineup.suplentes.map(mapId)},events:state.events.map(e=>({...e,outId:e.outId?mapId(e.outId):null,inId:e.inId?mapId(e.inId):null}))});
const states={101:mapState(facts.aggregate.states['101']),102:mapState(facts.aggregate.states['102'])};
facts.context.teams['101'].players=A;facts.context.teams['102'].players=B;
await pool.query(`INSERT INTO scoreboard_partidos(id,partido_torneo_id,sede_id,torneo_id,cancha,estado,updated_at,score_a,score_b,games_a,games_b,sets_a,sets_b,historial_sets,equipo_a_nombre,equipo_b_nombre,equipo_a_jugadores,equipo_b_jugadores) VALUES($1,90016,9,57,'1','finalizado',$2,2,1,0,0,2,1,$3,'Italia','España',$4,$5)`,[boardId,new Date(facts.finalAt).toISOString(),JSON.stringify(facts.board.historial_sets),JSON.stringify(A),JSON.stringify(B)]);
for(const p of facts.points)await pool.query('INSERT INTO scoreboard_historial_puntos(partido_id,timestamp,equipo) VALUES($1,$2,$3)',[boardId,p.timestamp,p.equipo]);
await pool.query('INSERT INTO nations_marker_private.nations_marker_match VALUES($1,$2,$3,$4,$5,$6)',[String(boardId),1,JSON.stringify(states),'active',JSON.stringify({start:{lineup:{101:1,102:1}}}),JSON.stringify({version:1,total:0,events:[],active:[]})]);
await pool.query("INSERT INTO nations_marker_private.games_finalization_intents VALUES($1,'completed',$2)",[boardId,new Date(facts.finalAt).toISOString()]);
const enq=await enqueueNationsPostmatchForPartido({pool,torneoId:57,partidoId:90016});
if(enq.status!=='queued')throw new Error(`enqueue failed: ${JSON.stringify(enq)}`);
const stubProvider={name:'stub',calls:0,async completeChat({userMessage}){this.calls+=1;const p=JSON.parse(userMessage);return {reply:JSON.stringify({title:'Nations demo',summary:`Resultado ${p.resultado.sets_a}-${p.resultado.sets_b}, super tie-break 10-9; A1 entró por A3 en el set 2 (elapsed 1050).`,highlights:[{type:'stats',text:`Puntos ${p.observed.team_totals.A.points}-${p.observed.team_totals.B.points}.`}],disclaimers:['Datos sintéticos del fixture.']})};}};
if(real&&process.env.NATIONS_DEMO_REAL_AUTHORIZED!=='1')throw new Error('--real-provider requires NATIONS_DEMO_REAL_AUTHORIZED=1 and ROOT execution');
if(real&&!process.env.ANTHROPIC_API_KEY)throw new Error('--real-provider requires ANTHROPIC_API_KEY');
const replyProvider={name:'reply-file',calls:0,async completeChat(){this.calls+=1;return {reply:JSON.stringify(replyPayload.reply??replyPayload.summary??replyPayload)}}}; const result=await processOneNationsPostmatchJob({pool,provider:real?undefined:(replyPayload?replyProvider:stubProvider)});
const row=(await pool.query('SELECT status,summary,observed,updated_at FROM nations_postmatch_ai.jobs WHERE scoreboard_id=$1',[boardId])).rows[0];
if(!row||row.status!=='ready')throw new Error(`summary not ready: ${JSON.stringify(result)}`);
let getResumen=null;
try {
 const app=express(); const fake={from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:table==='torneos'?{id:57,sede_id:9,plan_nations:{roster_publication_approved:true},modalidad_plantel:'selecciones',fecha_inicio:'2026-11-20',horas_revelar_equipos:24,es_prueba:true}:table==='partidos'?{id:90016,torneo_id:57,equipo_a_id:101,equipo_b_id:102}:null,error:null})};return q;}};
 mountNationsPostmatchRoutes(app,{pool,supabaseAdmin:fake,getAuthenticatedUser:async()=>({user:{id:'synthetic-demo'},status:200}),getRole:async()=>({rol:'super_admin'}),enabled:true});
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const res=await fetch(`http://127.0.0.1:${server.address().port}/api/nations/partidos/90016/resumen`,{headers:{authorization:'Bearer synthetic-demo'}});getResumen=await res.json();await new Promise(resolve=>server.close(resolve));
 if(!getResumen?.ok||getResumen?.state!=='ready')throw new Error(`GET resumen not ready: ${JSON.stringify(getResumen)}`);
} catch(error) { throw new Error(`GET resumen failed: ${error.message}`); }
const anon=anonymizeObserved(row.observed,facts);
const safe={status:'ready',mode,factsHash,requestHash:expectedRequestHash,getResumen,provider:real?'real':replyPayload?'reply-file':'stub',model:real?process.env.ANTHROPIC_MODEL||'default':'stub',enqueue:{status:enq.status,inserted:enq.inserted},summary:row.summary,observed:{points:anon.payload.team_totals,substitutions:anon.payload.substitutions,substitutions_timeline:anon.payload.substitutions_timeline},generatedAt:row.updated_at};
fs.writeFileSync(cache,JSON.stringify(safe,null,2),{mode:0o600});
const reportPath=path.resolve(process.env.NATIONS_POSTMATCH_REPORT||path.join(OUTDIR,`nations-postmatch-demo-${mode}-report.html`));
const txtPath=reportPath.replace(/\.html$/,'.txt');
const lines=[`mode: ${mode}`,`factsHash: ${factsHash}`,`summary: ${safe.summary.summary}`,`sets: 6-3, 3-6, 10-9 (super tie-break)`,`points: ${safe.observed.points.A.points}-${safe.observed.points.B.points} (${facts.points.length} observed points)`,...safe.observed.substitutions_timeline.map(x=>`${x.at} ${x.team}: ${x.swaps.map(s=>`${s.out} -> ${s.in}`).join(', ')}; points ${x.points_before.A}-${x.points_before.B}`)];
fs.writeFileSync(txtPath,lines.join('\n')+'\n',{mode:0o600});
fs.writeFileSync(reportPath,`<!doctype html><meta charset="utf-8"><title>Nations demo ${mode}</title><h1>Nations postmatch demo — ${mode}</h1><pre>${lines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`,{mode:0o600});
fs.writeFileSync(receiptPath,JSON.stringify({...safe,claim,cache,reportPath,txtPath,providerCalls:stubProvider?.calls??0},null,2),{mode:0o600});
emit({...safe,claim,cache,reportPath,txtPath,providerCalls:stubProvider?.calls??0});
await pool.end();
