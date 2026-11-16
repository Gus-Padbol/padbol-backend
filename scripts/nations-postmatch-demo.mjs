#!/usr/bin/env node
/** Local-only Nations postmatch demo. No production DB/provider by default. */
import fs from 'node:fs';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {buildNationsPostmatchScenario} from '../lib/torneos/nationsPostmatchScenario.js';
import {enqueueNationsPostmatchForPartido,processOneNationsPostmatchJob,anonymizeObserved} from '../lib/torneos/nationsPostmatchAi.js';

const args=new Set(process.argv.slice(2));
const real=args.has('--real-provider');
const stub=!real;
const DSN=process.env.NATIONS_POSTMATCH_PG_URL;
if(!DSN)throw new Error('Set NATIONS_POSTMATCH_PG_URL to a local postgres URL (host /tmp or localhost).');
const url=new URL(DSN); if(!['/tmp','127.0.0.1','localhost'].includes(url.hostname)&&!['/tmp','127.0.0.1','localhost'].includes(url.searchParams.get('host')))throw new Error('REFUSE_NON_LOCAL_DB');
const pool=new pg.Pool({connectionString:DSN,max:2});
const schema='nations_postmatch_ai';
const cache=path.resolve(process.env.NATIONS_POSTMATCH_CACHE||'/tmp/nations-postmatch-demo-cache.json');
const receiptPath=path.resolve(process.env.NATIONS_POSTMATCH_RECEIPT||'/tmp/nations-postmatch-demo-receipt.json');
if(fs.existsSync(cache)){console.log(JSON.stringify({status:'cached',cache,note:'no provider call; delete cache explicitly to rerun'},null,2));process.exit(0);}
await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS nations_marker_private CASCADE; DROP TABLE IF EXISTS scoreboard_historial_puntos, scoreboard_partidos, torneo_partido_alineaciones, equipos, partidos, torneos, sedes, canchas CASCADE`);
await pool.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA nations_marker_private;
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
const facts=buildNationsPostmatchScenario();
const A=facts.context.teams['101'].players,B=facts.context.teams['102'].players;
const U=(id)=>`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const boardId=U(1);
for(const [team,list] of [[101,A],[102,B]]){
 await pool.query('INSERT INTO equipos VALUES($1,57,NULL,$2,$3)',[team,JSON.stringify(list.map(p=>({user_id:U(p.id.slice(1)),nombre:p.name,estado:'confirmado'}))),'confirmado']);
 await pool.query('INSERT INTO torneo_partido_alineaciones VALUES(57,90016,$1,$2,$3,1)',[team,JSON.stringify(list.slice(0,2).map(p=>U(p.id.slice(1)))),JSON.stringify(list.slice(2).map(p=>U(p.id.slice(1))))]);
}
// Marker player IDs use the same UUIDs as lineup/context.
facts.context.teams['101'].players=A.map(p=>({...p,id:U(p.id.slice(1))}));facts.context.teams['102'].players=B.map(p=>({...p,id:U(p.id.slice(1))}));
for(const state of Object.values(facts.aggregate.states)){state.active=state.active.map(id=>U(id.slice(1)));state.roster=state.roster.map(id=>U(id.slice(1)));state.lineup={iniciales:state.lineup.iniciales.map(id=>U(id.slice(1))),suplentes:state.lineup.suplentes.map(id=>U(id.slice(1)))};state.events=state.events.map(e=>({...e,outId:e.outId?U(e.outId.slice(1)):null,inId:e.inId?U(e.inId.slice(1)):null}));}
await pool.query(`INSERT INTO scoreboard_partidos(id,partido_torneo_id,sede_id,torneo_id,cancha,estado,updated_at,score_a,score_b,games_a,games_b,sets_a,sets_b,historial_sets,equipo_a_nombre,equipo_b_nombre,equipo_a_jugadores,equipo_b_jugadores) VALUES($1,90016,9,57,'1','finalizado',$2,2,1,0,0,2,1,$3,'Italia','España',$4,$5)`,[boardId,facts.board.updated_at||new Date(facts.finalAt).toISOString(),JSON.stringify(facts.board.historial_sets),JSON.stringify(A),JSON.stringify(B)]);
for(const p of facts.points)await pool.query('INSERT INTO scoreboard_historial_puntos(partido_id,timestamp,equipo) VALUES($1,$2,$3)',[boardId,p.timestamp,p.equipo]);
await pool.query('INSERT INTO nations_marker_private.nations_marker_match VALUES($1,$2,$3,$4,$5,$6)',[String(boardId),1,JSON.stringify(facts.aggregate.states),'active',JSON.stringify({start:{lineup:{101:1,102:1}}}),JSON.stringify({version:1,total:0,events:[],active:[]})]);
await pool.query("INSERT INTO nations_marker_private.games_finalization_intents VALUES($1,'completed',$2)",[boardId,new Date(facts.finalAt).toISOString()]);
const enq=await enqueueNationsPostmatchForPartido({pool,torneoId:57,partidoId:90016});
if(enq.status!=='queued')throw new Error(`enqueue failed: ${JSON.stringify(enq)}`);
const provider=stub?{name:'stub',calls:0,async completeChat({userMessage}){this.calls++;const p=JSON.parse(userMessage);return {reply:JSON.stringify({title:'Nations demo',summary:`Resultado ${p.resultado.sets_a}-${p.resultado.sets_b}; ${p.observed.substitutions_timeline?.length||0} cambios observados.`,highlights:[{type:'stats',text:`Puntos ${p.observed.team_totals.A.points}-${p.observed.team_totals.B.points}.`}],disclaimers:['Datos sintéticos del fixture.']})};}}:null;
if(real&&!process.env.ANTHROPIC_API_KEY)throw new Error('--real-provider requires ANTHROPIC_API_KEY; ROOT must run it');
if(real)throw new Error('--real-provider is intentionally blocked in this demo until ROOT coordinates the one authorized call');
const result=await processOneNationsPostmatchJob({pool,provider});
const row=(await pool.query('SELECT status,summary,observed FROM nations_postmatch_ai.jobs WHERE scoreboard_id=$1',[boardId])).rows[0];
if(!row||row.status!=='ready')throw new Error(`summary not ready: ${JSON.stringify(result)}`);
const anon=anonymizeObserved(row.observed,facts);
const safeTimeline=anon.payload.substitutions_timeline;
const out={status:'ready',enqueue:{status:enq.status,inserted:enq.inserted},providerCalls:provider?.calls??0,summary:row.summary,observed:{points:anon.payload.team_totals,substitutions:anon.payload.substitutions,substitutions_timeline:safeTimeline},cache};
fs.writeFileSync(cache,JSON.stringify(out,null,2),{mode:0o600});
const receipt={status:'ok',stub,providerCalls:out.providerCalls,summary:row.summary,observedTimeline:anon.payload.substitutions_timeline,cache};fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2),{mode:0o600});
console.log(JSON.stringify(receipt,null,2));
await pool.end();
