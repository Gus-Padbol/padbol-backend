import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSedeIncentive} from './sedeIncentivesV4.js';
import {fixture,client,configured,userId} from './fixtures/incentivesV4Fixture.js';
function dates(tables,date='2026-09-04') {
  const teams=new Map(tables.equipos.map(t=>[t.id,t]));
  tables.partido_fecha_juego=tables.partidos.map(p=>({
    partido_id:p.id,torneo_id:p.torneo_id,sede_id:p.sede_id,fecha_juego:date,procedencia:'declaracion_operador',revision:1,vigente:true,
    resultado_snapshot:structuredClone(p.resultado),equipo_a_id:p.equipo_a_id,equipo_b_id:p.equipo_b_id,ganador_equipo_id:p.ganador_equipo_id,
    participantes_a:teams.get(p.equipo_a_id).jugadores.map(j=>j.user_id),participantes_b:teams.get(p.equipo_b_id).jugadores.map(j=>j.user_id),
    participantes_procedencia:'plantel_al_registrar_resultado',registrado_at:'2026-09-10T12:00:00Z',actualizado_at:'2026-09-10T12:00:00Z',
  }));return tables;
}
function manualOnly(){const t=fixture({digitalMatches:0});t.reservas=[];return dates(t);}
async function run(tables,period='2026-09-01',options={}) {const db=client(tables,options);const result=await evaluateSedeIncentive(db,configured,period,{manualDatesEnabled:true});assert.deepEqual(db.writes,[]);return {result,db};}
test('manual dates discover open tournaments and ten distinct linked verified people',async()=>{
 const t=manualOnly();t.torneos[0].estado='en_curso';t.torneos[0].fecha_fin='2026-12-30';
 const {result}=await run(t);assert.equal(result.metrics.jugadores_activos,10);assert.equal(result.metrics.torneos_integrales_validos,0);assert.equal(result.evaluation.criterios.jugadores_activos,true);assert.equal(result.evaluation.cumplido,false);
});
test('historical roster survives team edits and disappears from neither account discovery nor activity',async()=>{
 const t=manualOnly();t.partidos=t.partidos.slice(0,1);t.partido_fecha_juego=t.partido_fecha_juego.slice(0,1);t.equipos=[];t.torneos[0].estado='en_curso';
 const {result,db}=await run(t);assert.equal(result.metrics.jugadores_activos,4);assert(db.requests.some(q=>q.table==='jugadores_perfil'));
});
test('manual legacy without historical UUIDs cannot borrow current roster',async()=>{
 const t=manualOnly();t.partido_fecha_juego.forEach(d=>{d.participantes_a=null;d.participantes_b=null;d.participantes_procedencia='sin_evidencia_historica';});
 assert.equal((await run(t)).result.metrics.jugadores_activos,0);
});
test('date correction moves only manual activity between months, never closing or recording month',async()=>{
 const t=manualOnly();t.partido_fecha_juego.forEach(d=>{d.fecha_juego='2026-08-21';});
 assert.equal((await run(t,'2026-08-01')).result.metrics.jugadores_activos,10);assert.equal((await run(t)).result.metrics.jugadores_activos,0);
 t.partido_fecha_juego.forEach(d=>{d.fecha_juego='2026-09-02';d.revision=2;});
 assert.equal((await run(t,'2026-08-01')).result.metrics.jugadores_activos,0);assert.equal((await run(t)).result.metrics.jugadores_activos,10);
});
test('same person counts once per month and can participate again next month',async()=>{
 const t=manualOnly();t.partido_fecha_juego.forEach((d,i)=>{d.fecha_juego=i<4?'2026-08-21':'2026-09-02';});
 assert.equal((await run(t,'2026-08-01')).result.metrics.jugadores_activos,8); // only fully eligible pairs: first two matches
 assert.equal((await run(t)).result.metrics.jugadores_activos,10);
});
for(const [name,change] of [
 ['revoked venue links',t=>{t.sede_jugadores=[];}],
 ['other venue links',t=>t.sede_jugadores.forEach(r=>{r.sede_id=99;})],
 ['inactive venue links',t=>t.sede_jugadores.forEach(r=>{r.estado='inactivo';})],
 ['profiles unavailable',t=>{t.jugadores_perfil=[];}],
 ['invalidated dates',t=>t.partido_fecha_juego.forEach(r=>{r.vigente=false;})],
 ['wrong venue snapshot',t=>t.partido_fecha_juego.forEach(r=>{r.sede_id=99;})],
 ['changed sporting result',t=>t.partidos.forEach(r=>{r.resultado={};})],
 ['changed winner',t=>t.partidos.forEach(r=>{r.ganador_equipo_id=999;})],
 ['non Padbol tournament',t=>{t.torneos[0].deporte='padel';}],
 ['non doubles tournament',t=>{t.torneos[0].formato_equipo='singles';}],
 ['future date relative to server stamp',t=>t.partido_fecha_juego.forEach(r=>{r.actualizado_at='2026-09-01T00:00:00Z';r.registrado_at=r.actualizado_at;})],
])test('manual evidence rejects '+name,async()=>{const t=manualOnly();change(t);assert.equal((await run(t)).result.metrics.jugadores_activos,0);});
test('missing or unconfirmed accounts do not become manual monthly participants',async()=>{
 const t=manualOnly();for(const option of [{unverified:new Set(t.jugadores_perfil.map(p=>p.user_id))},{missingUsers:new Set(t.jugadores_perfil.map(p=>p.user_id))}])assert.equal((await run(t,'2026-09-01',option)).result.metrics.jugadores_activos,0);
});
test('manual dates do not satisfy the final digital requirement',async()=>{
 const {result}=await run(manualOnly());assert.equal(result.metrics.torneos_resultados_completos,1);assert.equal(result.metrics.torneos_integrales_validos,0);assert.equal(result.metrics.jugadores_activos,10);assert.equal(result.evaluation.cumplido,false);
});
test('manual other matches plus final digital preserve twelve bookings and all four joint goals',async()=>{
 const t=dates(fixture({digitalMatches:1}));const {result}=await run(t);
 assert.equal(result.metrics.reservas_validas,12);assert.equal(result.metrics.torneos_integrales_validos,1);assert.equal(result.evaluation.criterios_requeridos,4);assert.equal(result.evaluation.cumplido,true);assert.equal(result.commercial_status.projected_monthly_usd,17);assert.equal(result.commercial_status.billing_enabled,false);assert.equal(result.credito_otorgado,false);assert.equal(result.persisted,false);
});
test('digital activity remains even if date snapshot is unavailable or invalid',async()=>{
 for(const mutation of [t=>{},t=>t.partido_fecha_juego.forEach(d=>{d.participantes_procedencia='sin_evidencia_historica';d.participantes_a=null;d.participantes_b=null;})]){
 const t=dates(fixture());t.reservas=[];mutation(t);const {result}=await run(t,'2026-09-01',{failTable:'partido_fecha_juego'});assert.equal(result.metrics.jugadores_activos,16);assert.equal(result.evaluation.criterios.jugadores_activos,true);
 }
});
test('digital point month has precedence over declared manual month for the same match',async()=>{
 const t=fixture();t.reservas=[];t.partidos=t.partidos.slice(0,1);t.partidos[0].resultado.fuente_resultado='manual_admin';dates(t,'2026-08-21');t.torneos[0].estado='en_curso';
 assert.equal((await run(t,'2026-08-01')).result.metrics.jugadores_activos,0);assert.equal((await run(t)).result.metrics.jugadores_activos,4);
});
test('active replacement scoreboard prevents reusing stale declared result',async()=>{
 const t=manualOnly();t.partidos=t.partidos.slice(0,1);t.partido_fecha_juego=t.partido_fecha_juego.slice(0,1);
 t.scoreboard_partidos=[{id:userId(999),partido_torneo_id:t.partidos[0].id,torneo_id:101,sede_id:7,estado:'en_curso',updated_at:'2026-09-10T13:00:00Z'}];
 assert.equal((await run(t)).result.metrics.jugadores_activos,0);
});
test('incomplete read evidence reports known digital lower bound without losing proved minimum',async()=>{
 const t=fixture();t.reservas=[];t.partidos=t.partidos.slice(0,1);
 const {result}=await run(t,'2026-09-01',{failTable:'partido_fecha_juego'});
 assert.equal(result.metrics.jugadores_activos,null);assert.equal(result.evidence_notes.jugadores_activos_conteo_minimo_conocido,4);assert.equal(result.evaluation.detalle_criterios.jugadores_activos.state,'unavailable');
});
test('default OFF makes no new table calls and preserves old digital numbers',async()=>{
 const t=manualOnly();const db=client(t);const result=await evaluateSedeIncentive(db,configured,'2026-09-01');
 assert.equal(result.metrics.jugadores_activos,0);assert(!db.requests.some(q=>q.table==='partido_fecha_juego'));assert.equal(result.evidence_notes.fecha_declarada_lectura_habilitada,false);
});
test('private table pagination orders by its actual partido_id primary key',async()=>{
 const t=manualOnly();const row=t.partido_fecha_juego[0];t.partido_fecha_juego=Array.from({length:1001},(_,i)=>({...row,partido_id:10000+i}));
 const {db}=await run(t);const reads=db.requests.filter(q=>q.table==='partido_fecha_juego');assert.equal(reads.length,2);assert.deepEqual(reads.map(q=>q.range),[[0,999],[1000,1999]]);assert(!reads[0].columns.includes('actor_id'));
});
test('aggregate evaluation DTO never exposes historical participants or operator',async()=>{
 const {result}=await run(manualOnly());const text=JSON.stringify(result);assert(!text.includes(userId(1)));assert(!text.includes('participantes_a'));assert(!text.includes('actor_id'));assert(!text.includes('motivo_correccion'));
});
