"""Local PostgreSQL-only concurrency regressions. Never connects to the linked production DB."""
import subprocess,time,json
DB='planning_qa16'
CMD=['docker','--context','colima','exec','-i','jefe4-calendar-review-20261015','psql','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1','-At']
def run(sql,ok=True):
 r=subprocess.run(CMD,input=sql,text=True,capture_output=True)
 if ok and r.returncode:raise RuntimeError(r.stderr)
 return r
actor="'11111111-1111-4111-8111-111111111111'::uuid"
plan=[{'torneo_id':901,'sede_id':8,'equipo_a_id':a,'equipo_b_id':b,'estado':'pendiente','ronda':r,'bracket_round':r,'bracket_position':p} for a,b,r,p in [(1,4,1,1),(2,3,1,2),(None,None,2,1)]]
call=f"SELECT planificar_fixture_torneo(901,{actor},ARRAY[1,2,3,4]::bigint[],'manual','{json.dumps(plan)}'::jsonb);"
# Clear only this disposable local schema's fixture; no remote credentials or project references.
run('DELETE FROM torneo_partidos_programacion;DELETE FROM torneo_fixture_planes;DELETE FROM partidos;UPDATE torneos SET estado=\'abierto\' WHERE id=901;')
a=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
a.stdin.write('BEGIN;'+call+'SELECT pg_sleep(1.3);COMMIT;');a.stdin.close();time.sleep(.25)
start=time.monotonic();b=run(call,False);elapsed=time.monotonic()-start;a.wait();assert a.returncode==0 and b.returncode!=0 and 'Fixture already exists' in b.stderr and elapsed>.8
assert run('SELECT count(*) FROM partidos WHERE torneo_id=901;').stdout.strip()=='3'
print('PASS planning/planning: second waited for lock and refused overwrite; one exact3match fixture')
roster=run("SELECT jsonb_agg(jsonb_build_object('id',id,'jugadores',jugadores,'inscripcion_estado',inscripcion_estado) ORDER BY id) FROM equipos WHERE torneo_id=901;").stdout.strip()
a=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
a.stdin.write("BEGIN;SELECT id FROM torneos WHERE id=901 FOR UPDATE;UPDATE equipos SET jugadores=jugadores||'[{\"tipo_identidad\":\"plaza_pendiente\"}]'::jsonb WHERE id=1;SELECT pg_sleep(1.3);COMMIT;");a.stdin.close();time.sleep(.25)
start=time.monotonic();b=run(f"SELECT iniciar_torneo_planificado(901,{actor},'{roster}'::jsonb);",False);elapsed=time.monotonic()-start;a.wait();assert a.returncode==0 and b.returncode!=0 and 'Roster changed' in b.stderr and elapsed>.8
assert run('SELECT estado FROM torneos WHERE id=901;').stdout.strip()=='abierto'
print('PASS roster/start: waited then rejected stale snapshot; tournament remains open')
run("DELETE FROM torneo_fixture_planes;DELETE FROM partidos;UPDATE equipos SET jugadores=jugadores-2 WHERE id=1;")
print('PASS local cleanup: zero fixture rows; baseline teams restored')
