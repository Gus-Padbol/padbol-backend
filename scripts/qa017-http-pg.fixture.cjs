module.exports.start = async function start({port=55494,legacy=false,invalidLegacy=false,lateFailure=false,missingGuardDependency=false}={}) {
// Test-only joint renderer/HTTP/PG fixture, derived from accepted32 setup. No checks execute on import.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),{Pool,types}=require(path.resolve(root,'../../node_modules/pg'));types.setTypeParser(1082,v=>v);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cl-a-')),data=path.join(dir,'d'),sock=path.join(dir,'s');fs.mkdirSync(sock);
// macOS PostgreSQL startup requires an explicit valid locale under env-i. Child processes only.
const env={...process.env,LC_ALL:'C',PGHOST:sock,PGPORT:String(port),PGUSER:'postgres',PGDATABASE:'class_a'};
const run=(cmd,args)=>execFileSync(cmd,args,{env,encoding:'utf8'});let pool,server,started=false;const beforeLifecycle=false,beforeGeneral=false;const passed=[];
const pass=n=>{passed.push(n);console.log('PASS '+n);};
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user=n=>({id:uid(n),email:`fixture${n}@example.invalid`});
function db(){return {from(table){const f=[];let cols='*',update=null,insertRows=null,conditional=false,orders=[],lim=null;const q={select(c){cols=c||'*';return q;},update(p){update=p;return q;},insert(p){insertRows=Array.isArray(p)?p:[p];return q;},or(){conditional=true;return q;},single(){return execute(true);},eq(k,v){f.push([k,'=',v]);return q;},neq(k,v){f.push([k,'<>',v]);return q;},order(k,o){orders.push([k,o]);return q;},limit(n){lim=n;return q;},maybeSingle(){return execute(true);},then(a,b){return execute(false).then(a,b);}};async function execute(single){try{const joined=cols.includes('!inner('),prefix=joined?(table==='clases'?'c.':'i.'):'';const vals=f.map(x=>x[2]);const where=f.length?' WHERE '+f.map(([k,op],n)=>`${k.startsWith('profesores.')?'p.'+k.slice(11):prefix+k}${op}$${n+1}`).join(' AND '):'';let sql;
if(joined&&table==='clases')sql='SELECT c.*,row_to_json(p) profesores FROM clases c JOIN profesores p ON p.id=c.profesor_id';
else if(joined)sql="SELECT i.id,i.clase_id,i.user_id,i.fecha,i.hora_inicio,i.estado,i.ocurrencia_id,i.asistio,i.asistencia_marcada_at,i.created_at,jsonb_build_object('id',c.id,'titulo',c.titulo,'deporte',c.deporte,'sede_id',c.sede_id,'sedes',row_to_json(s),'profesores',row_to_json(p)) clases FROM inscripciones_clases i JOIN clases c ON c.id=i.clase_id JOIN profesores p ON p.id=c.profesor_id JOIN sedes s ON s.id=c.sede_id";
else sql=`SELECT ${cols} FROM ${table}`;let r;if(insertRows){const keys=Object.keys(insertRows[0]),iv=keys.map(k=>insertRows[0][k]);r=await pool.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,n)=>'$'+(n+1)).join(',')}) RETURNING *`,iv);}else if(update){const keys=Object.keys(update),uvals=keys.map(k=>update[k]);const uw=f.map(([k,op,v])=>{uvals.push(v);return k+op+'$'+uvals.length;});r=await pool.query(`UPDATE ${table} SET ${keys.map((k,n)=>k+'=$'+(n+1)).join(',')} WHERE ${uw.join(' AND ')}${conditional?" AND (estado IS NULL OR estado<>'cancelada')":''} RETURNING *`,uvals);}else r=await pool.query(sql+where+(orders.length?' ORDER BY '+orders.map(([k,o])=>(joined?prefix:'')+k+(o?.ascending===false?' DESC':' ASC')).join(','):'')+(lim?' LIMIT '+Number(lim):''),vals);return {data:single?r.rows[0]||null:r.rows,error:null};}catch(error){return{data:null,error};}}return q;},async rpc(name,args){let c;try{assert.equal(name,'clases_ocurrencia_comando');c=await pool.connect();await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');const keys=Object.keys(args),r=await c.query(`SELECT public.clases_ocurrencia_comando(${keys.map((k,n)=>k+' => $'+(n+1)).join(',')}) result`,Object.values(args));await c.query('COMMIT');return{data:r.rows[0].result,error:null};}catch(error){if(c)await c.query('ROLLBACK');return{data:null,error};}finally{c?.release();}}};}
async function req(n,method,url,body){const r=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{'Content-Type':'application/json',...(n?{Authorization:'Bearer '+n}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};}

let stopped=false;
async function stop(){if(stopped)return;stopped=true;if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();if(started)run('pg_ctl',['-D',data,'stop','-m','fast']);fs.rmSync(dir,{recursive:true,force:true});console.log('OWN_QA017_PG_STOPPED_REMOVED');}
try{

run('initdb',['-D',data,'-U','postgres','--auth=trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',data,'-o',`-h '' -k ${sock} -p ${port} -c listen_addresses=''`,'-l',path.join(dir,'pg.log'),'start']);started=true;run('createdb',['class_a']);pool=new Pool({host:sock,port,user:'postgres',database:'class_a',max:8});
// Effective relevant columns/types/NOT NULL/CHECK/FKs; local synthetic identities only.
await pool.query('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS');
const prereq=JSON.parse(fs.readFileSync(path.join(root,'scripts/qa017-prerequisite-schema.fixture.json')));
await pool.query(prereq.schema);
// Relevant exact QA drift: absent tipo_sede, with its synthetic-only constraints removed.
await pool.query('ALTER TABLE sedes DROP COLUMN tipo_sede CASCADE');
const migration=fs.readFileSync(path.join(root,'sql/migrations/20261016140000_tournament_generic_participants.sql'),'utf8');
await pool.query(migration.slice(0,migration.indexOf('CREATE OR REPLACE FUNCTION public.participante_plantel_congelado'))+'COMMIT;');
await pool.query(prereq.registration);
await pool.query('CREATE TABLE scoreboard_linked_suspend_candidate(booking_id bigint,scoreboard_id bigint,open_id bigint);CREATE TABLE scoreboard_partidos(id bigint,estado text,reserva_id bigint,partido_abierto_id bigint);CREATE TABLE partidos_abiertos(id bigint,reserva_id bigint)');
await pool.query(`INSERT INTO sedes(id,nombre,pais,ciudad,moneda,timezone) VALUES(7,'Fixture venue','AR','Fixture city','ARS','America/Argentina/Buenos_Aires'),(8,'Other venue','AR','Fixture city','ARS','America/Argentina/Buenos_Aires');
INSERT INTO canchas VALUES(11,7,1),(12,8,1),(13,7,2),(14,7,3);
INSERT INTO profesores VALUES(1,true,true,'Synthetic','Instructor',7,ARRAY['padbol'],'aprobado');
INSERT INTO clases VALUES(1,7,1,11,'padbol','Class A','grupal',1,60,0,true,0),(2,7,1,11,'padbol','Class B','grupal',2,60,0,true,0),(3,8,1,12,'padbol','Class C','grupal',2,60,0,true,0);
INSERT INTO auth.users SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'fixture'||i||'@example.invalid' FROM generate_series(1,100)i;
INSERT INTO jugadores_perfil VALUES('${uid(90)}','fixture90@example.invalid','Synthetic','Organizer','+541155550090');
INSERT INTO clases_horarios SELECT i*10+d,i,d,'18:00','19:00' FROM generate_series(1,3)i CROSS JOIN generate_series(0,6)d;`);
const docs='/Users/padbol2022/Documents/Codex/2026-11-23/CLASES-OCURRENCIA-001';const guard=JSON.parse(fs.readFileSync(path.join(docs,'COMPATIBILIDAD-GUARD-SOLAPES.json'))).definitions[0].definition;
const interval=JSON.parse(fs.readFileSync('/Users/padbol2022/Documents/Codex/2026-11-23/INTEGRACION-CIERRES-LOCALES-001/QA015-CATALOGO-ADDENDUM-REMOTO-PRE.json')).functions.find(f=>f.exists&&f.signature.startsWith('reserva_intervalo_guard(')).definition;
await pool.query(interval);await pool.query(guard);
if(legacy||invalidLegacy){
 await pool.query("INSERT INTO reservas(sede,sede_id,fecha,hora,hora_inicio,cancha,cancha_id,nombre,email,telefono,whatsapp,nivel,precio,estado,duracion_minutos,user_id,tipo) VALUES('Fixture venue',7,CASE WHEN $1 THEN 'not-a-date' ELSE ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date+1)::text END,'18:00','18:00',1,11,'Legacy','fixture2@example.invalid','+541155550002','+541155550002','Clase',0,'confirmada',60,$2,'clase')",[invalidLegacy,uid(2)]);
 await pool.query("INSERT INTO inscripciones_clases(clase_id,user_id,fecha,hora_inicio,estado,reserva_cancha_id) VALUES(2,$1,(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date+1,'18:00','confirmada',1)",[uid(2)]);
}
// Seed historical rows before installing the CURRENT overlap trigger: this is fixture history, not a runtime bypass.
await pool.query('CREATE TRIGGER reservas_sin_solape BEFORE INSERT OR UPDATE ON reservas FOR EACH ROW EXECUTE FUNCTION reservas_guardar_sin_solape()');
if(legacy)await pool.query("INSERT INTO inscripciones_clases(clase_id,user_id,fecha,hora_inicio,estado) VALUES(1,$1,(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,'18:00','cancelada')",[uid(2)]);
if(missingGuardDependency)await pool.query('DROP TABLE scoreboard_linked_suspend_candidate');
const installer=fs.readFileSync(path.join(root,'sql/candidates/20261124_qa_legacy_compat017_install_bundle.sql'),'utf8');
const beforeRegistration=(await pool.query("SELECT pg_get_functiondef('gestionar_participantes_torneo(bigint,uuid,text,jsonb)'::regprocedure) d")).rows[0].d;
const installClient=await pool.connect();
try{await installClient.query(lateFailure?installer.replace(/COMMIT;\s*$/, "DO $late$ BEGIN RAISE EXCEPTION 'QA017_LATE_FAULT'; END $late$; COMMIT;"):installer);}
catch(error){await installClient.query('ROLLBACK');const check=(await installClient.query("SELECT to_regclass('clases_ocurrencias') IS NULL AND to_regclass('store_orders') IS NULL absent,pg_get_functiondef('gestionar_participantes_torneo(bigint,uuid,text,jsonb)'::regprocedure) d")).rows[0];assert.equal(check.absent,true);assert.equal(check.d,beforeRegistration);console.log('INSTALL_FAILURE_FULL_ROLLBACK_VERIFIED');throw error;}
finally{installClient.release();}
assert.equal((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
await pool.query('GRANT USAGE ON SCHEMA public TO service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role');
const express=(await import('express')).default,app=express();app.use(express.json());const {registerModuloClasesRoutes}=await import(pathToFileURL(path.join(root,beforeLifecycle?'artifacts/clases-lifecycle-before/lib/moduloClases.js':'lib/moduloClases.js')));
registerModuloClasesRoutes(app,{supabaseAdmin:db(),supabase:db(),authUserFromBearer:async req=>{const n=Number(String(req.headers.authorization||'').replace('Bearer ',''));return n>0&&n<=100?user(n):null;},adminListScopeFromRequest:async req=>{const n=Number(String(req.headers.authorization||'').replace('Bearer ',''));return !n?null:{rol:n>=90?'admin_club':'jugador',superA:n===99,venue:n===91?8:7};},assertUsuarioPuedeAdministrarSede:async(req,venue)=>{const n=Number(String(req.headers.authorization||'').replace('Bearer ',''));if(n!==99&&Number(venue)!==(n===91?8:7))throw Object.assign(new Error('Other venue'),{status:403});}});
server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const today=(await pool.query("SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text d")).rows[0].d;
const future=(await pool.query('SELECT ($1::date+1)::text d',[today])).rows[0].d;

return {baseUrl:`http://127.0.0.1:${server.address().port}`,pool,user,actors:{staff:90,studentA:1,studentB:2,superAdmin:99},context:{clase_id:1,fecha:today,hora_inicio:'18:00'},stop};
}catch(error){
const logFile=path.join(dir,'pg.log');
const diagnostics={pg_log:fs.existsSync(logFile)?fs.readFileSync(logFile,'utf8').slice(-6000):null,stdout:String(error.stdout||'').slice(-2000),stderr:String(error.stderr||'').slice(-2000),cleaned:false};
try{if(!started&&fs.existsSync(path.join(data,'postmaster.pid'))){try{run('pg_ctl',['-D',data,'status']);started=true;}catch{}}await stop();diagnostics.cleaned=!fs.existsSync(dir);}catch(cleanupError){diagnostics.cleanup_error=cleanupError.message;}
error.fixtureDiagnostics=diagnostics;error.message+='\nLocal PG fixture diagnostics: '+JSON.stringify(diagnostics);throw error;
}
};
