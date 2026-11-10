import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
export const ACTOR = '11111111-1111-4111-8111-111111111111';
export const uid = n => `22222222-2222-4222-8222-${String(n).padStart(12,'0')}`;
export const players = (team,n=8) => Array.from({length:n},(_,i)=>({user_id:uid(team*100+i+1),nombre:`Synthetic ${team}-${i+1}`,estado:'confirmado'}));
export const match = (id=101,a=1,b=2,cancha='1') => ({id,torneo_id:901,sede_id:8,equipo_a_id:a,equipo_b_id:b,cancha,cancha_id:cancha===null?null:12+Number(cancha),estado:'pendiente'});
export const schema = `CREATE TABLE torneos(id bigint primary key,nombre text,sede_id bigint,modalidad_plantel text,deporte text,estado text,plan_nations jsonb);
CREATE TABLE user_roles(user_id uuid,email text,role text,alcance text,sede_id bigint,organizacion_id bigint,pais text,provincia text,ciudad text,nombre text,torneos_oficiales_habilitados boolean);
CREATE TABLE partidos(id bigint primary key,torneo_id bigint,sede_id bigint,cancha text,cancha_id bigint,fecha_hora timestamptz,estado text,equipo_a_id bigint,equipo_b_id bigint,grupo text,ronda int);
CREATE TABLE equipos(id bigint primary key,torneo_id bigint,nombre text,jugadores jsonb);
CREATE TABLE canchas(id bigint primary key,sede_id bigint,orden int,estado text,deporte text);
CREATE TABLE torneo_partido_alineaciones(partido_id bigint,equipo_id bigint,torneo_id bigint,iniciales uuid[],suplentes uuid[]);
CREATE TABLE scoreboard_partidos(id text primary key default gen_random_uuid()::text,partido_torneo_id bigint,torneo_id bigint,torneo_nombre text,sede_id bigint,cancha text,equipo_a_nombre text,equipo_b_nombre text,equipo_a_jugadores jsonb,equipo_b_jugadores jsonb,jersey_a1 int,jersey_a2 int,jersey_a3 int,jersey_a4 int,jersey_b1 int,jersey_b2 int,jersey_b3 int,jersey_b4 int,saque_actual text,color_a text,color_b text,estado text,control_token_hash text,control_token_created_at timestamptz,control_token_revoked_at timestamptz,updated_at timestamptz default now(),created_at timestamptz default now(),score_a int default 0,score_b int default 0,games_a int default 0,games_b int default 0,sets_a int default 0,sets_b int default 0,historial_puntos jsonb default '[]',cronometro_inicio timestamptz,cronometro_pausado boolean default false,cronometro_segundos int default 0);
CREATE UNIQUE INDEX idx_scoreboard_partidos_partido_torneo_activo ON scoreboard_partidos(partido_torneo_id) WHERE partido_torneo_id IS NOT NULL AND estado NOT IN ('terminado','finalizado');
CREATE TABLE sedes(id bigint primary key,nombre text,timezone text);
CREATE TABLE reservas(id bigint, sede_id bigint,sede text,cancha int,estado text,fecha text,hora text,duracion_minutos int);
CREATE TABLE clases(id bigint,cancha_id bigint,activo boolean);
CREATE TABLE clases_horarios(clase_id bigint,dia_semana int,hora_inicio time,hora_fin time);
CREATE TABLE torneo_partidos_programacion(partido_id bigint,court_id bigint,inicio timestamptz,duration_minutes int);
CREATE TABLE torneo_nations_programacion(partido_id bigint,torneo_id bigint,court_id bigint,inicio timestamptz,duration_minutes int);
`;
export const readSql = name => readFileSync(new URL(`../../${name}`, import.meta.url),'utf8');
export function exactFunction(path,name) {
 const sql=readSql(path);const start=sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);const end=sql.indexOf('END $$;',start);
 if(start<0||end<0)throw Error('Fixture function absent');return sql.slice(start,end+7);
}
export async function seedRow(db,table,row){const keys=Object.keys(row);await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));}
export async function installFixture(db,{nations=false,matches=[match()],existing=[],patched=true}={}) {
 const exec = sql => db.exec ? db.exec(sql) : db.query(sql);
 await exec(schema);
 await exec("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;");
 await seedRow(db,'torneos',{id:901,nombre:'Synthetic tournament',sede_id:8,modalidad_plantel:nations?'selecciones':'dobles',deporte:'padbol',estado:'en_curso',plan_nations:nations?{}:null});
 await seedRow(db,'user_roles',{user_id:ACTOR,email:'qa@example.invalid',role:'admin_club',sede_id:8});
 await seedRow(db,'sedes',{id:8,nombre:'Synthetic venue',timezone:'UTC'});
 for(let i=1;i<=8;i++)await seedRow(db,'equipos',{id:i,torneo_id:901,nombre:`Team ${i}`,jugadores:players(i)});
 for(let i=1;i<=3;i++)await seedRow(db,'canchas',{id:12+i,sede_id:8,orden:i,estado:'activa',deporte:'padbol'});
 for(const m of matches){await seedRow(db,'partidos',m);if(m.equipo_a_id&&m.equipo_b_id)for(const t of [m.equipo_a_id,m.equipo_b_id])await db.query('INSERT INTO torneo_partido_alineaciones VALUES($1,$2,901,$3,$4)',[m.id,t,[uid(t*100+1),uid(t*100+2)],[uid(t*100+3),uid(t*100+4)]]);}
 for(const row of existing)await seedRow(db,'scoreboard_partidos',row);
 for(const [path,name] of [['sql/migrations/20261019130000_tournament_marker_without_schedule.sql','proteger_cancha_marcador_activo'],['sql/migrations/20261019130000_tournament_marker_without_schedule.sql','proteger_marcador_nations'],['sql/candidates/20261109200000_nations_lineups_2_3_forward.sql','proteger_marcador_seleccion']]) {
  await exec(exactFunction(path,name));await exec(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
 }
 await exec(exactFunction('sql/migrations/20261019131500_nations_marker_authorized_court_context.sql','preparar_marcador_torneo_ahora'));
 if(patched)await exec(readSql('supabase/migrations/20261109120000_scoreboard_bulk_preparation.sql'));
}
export async function fixture(options={}) {
 const db=new PGlite();await installFixture(db,options);
 let previous=Promise.resolve();
 const pool={async connect(){let release;const pending=new Promise(r=>release=r);const wait=previous;previous=pending;await wait;return {query:(...args)=>db.query(...args),release};}};
 return {db,pool,auth:{user:{id:ACTOR}},rows:async()=>(await db.query('SELECT * FROM scoreboard_partidos ORDER BY partido_torneo_id,id')).rows,close:()=>db.close()};
}
