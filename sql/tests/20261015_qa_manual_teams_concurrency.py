"""Concurrency against the existing disposable local PostgreSQL container only."""
import subprocess,json,time
D=['docker','--context','colima','exec','-i','jefe4-calendar-review-20261015','psql','-U','postgres','-d','chivi_manual_20261015','-v','ON_ERROR_STOP=1','-At']
actor="'11111111-1111-4111-8111-111111111111'::uuid"
def uid(i):return "'22222222-2222-4222-8222-"+str(i).zfill(12)+"'::uuid"
def team(a,b,ref):return f"SELECT public.gestionar_dupla_qa(555,{actor},'crear','QA Concurrent',ARRAY[{uid(a)},{uid(b)}],'44444444-4444-4444-8444-{ref:012}'::uuid);"
def run(sql):
 r=subprocess.run(D,input=sql,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def reset():run("TRUNCATE public.partidos,public.equipos CASCADE; UPDATE public.torneos SET estado='abierto' WHERE id=555;")
def fixture(ids):
 data=[{'torneo_id':555,'sede_id':8,'equipo_a_id':ids[0],'equipo_b_id':ids[1],'estado':'pendiente','ronda':1,'bracket_round':1,'bracket_position':1}]
 return f"SELECT public.guardar_fixture_qa(555,{actor},ARRAY[{','.join(map(str,ids))}]::bigint[],'{json.dumps(data)}'::jsonb);"
def compete(label,first,second,expected):
 a=subprocess.Popen(D,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 a.stdin.write('BEGIN;\n'+first+'\nSELECT pg_sleep(1.5);\nCOMMIT;\n');a.stdin.close()
 while True:
  line=a.stdout.readline()
  if line.startswith('{'):break
  if not line:raise RuntimeError('First connection did not reach locked operation: '+a.stderr.read())
 start=time.monotonic();b=subprocess.run(D,input='\\set VERBOSITY verbose\n'+second,text=True,capture_output=True)
 wait=time.monotonic()-start;a.wait(timeout=15)
 if a.returncode or b.returncode==0 or expected not in b.stderr or wait<1:raise AssertionError(label+' concurrency failed '+b.stderr)
 return {'case':label,'passed':True,'second_sqlstate':expected,'blocked_seconds':round(wait,2)}
report=[]
reset();report.append(compete('manual vs manual same players',team(1,2,9001),team(1,2,9002),'23505'))
reset();run(team(1,2,9010));run(team(3,4,9011));ids=json.loads(run('SELECT json_agg(id ORDER BY id) FROM equipos WHERE torneo_id=555;'))
report.append(compete('manual entry wins; stale fixture rejected',team(5,6,9012),fixture(ids),'40001'))
reset();run(team(1,2,9020));run(team(3,4,9021));ids=json.loads(run('SELECT json_agg(id ORDER BY id) FROM equipos WHERE torneo_id=555;'))
report.append(compete('fixture wins; later manual entry rejected',fixture(ids),team(5,6,9022),'55000'))
reset()
remaining=json.loads(run("SELECT json_build_object('teams',(SELECT count(*) FROM equipos),'matches',(SELECT count(*) FROM partidos),'requests',(SELECT count(*) FROM torneo_qa_inscripcion_requests));"))
if any(remaining.values()):raise AssertionError('Local concurrency residues')
print(json.dumps({'status':'PASS','cases':report,'remaining_local_mutations':remaining},indent=2))
