"""Real independent PostgreSQL connections; only isolated local participants_qa16 DB."""
import subprocess,json,time,uuid
D=['docker','--context','colima','exec','-i','jefe4-calendar-review-20261015','psql','-U','postgres','-d','participants_qa16','-v','ON_ERROR_STOP=1','-At']
ADMIN='11111111-1111-4111-8111-111111111111';CAP='22222222-2222-4222-8222-000000000001';U3='22222222-2222-4222-8222-000000000003';U4='22222222-2222-4222-8222-000000000004'
def literal(v):return "'"+v.replace("'","''")+"'"
def call(actor,action,**body):return 'SELECT public.gestionar_participantes_torneo(555,'+literal(actor)+'::uuid,'+literal(action)+','+literal(json.dumps({'request_id':str(uuid.uuid4()),**body}))+'::jsonb);'
def run(sql):
 p=subprocess.run(D,input=sql,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr)
 return p.stdout.strip()
def reset():run("TRUNCATE public.scoreboard_partidos,public.partidos,public.equipos,public.torneo_participantes,public.torneo_participante_operaciones CASCADE; UPDATE public.torneos SET estado='abierto' WHERE id=555;")
def race(label,a_sql,b_sql,sqlstate):
 a=subprocess.Popen(D,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);a.stdin.write('BEGIN;'+a_sql+' SELECT pg_sleep(1.5);COMMIT;');a.stdin.close()
 while True:
  line=a.stdout.readline()
  if line.startswith('{'):break
  if not line:raise AssertionError('First operation failed '+a.stderr.read())
 start=time.monotonic();b=subprocess.run(D,input='\\set VERBOSITY verbose\n'+b_sql,text=True,capture_output=True);elapsed=time.monotonic()-start;a.wait(timeout=20)
 assert a.returncode==0 and b.returncode!=0 and sqlstate in b.stderr and elapsed>1,(label,b.stderr)
 return {'case':label,'passed':True,'second_sqlstate':sqlstate,'blocked_seconds':round(elapsed,2)}
report=[]
try:
 reset();body={'nombre':'Captain plus guest','participantes':[{'tipo_identidad':'generico','nombre':'Guest'}]}
 report.append(race('one captain cannot enroll concurrently into two teams',call(CAP,'inscribir',**body),call(CAP,'inscribir',**body),'23505'))
 assert run('SELECT count(*) FROM public.torneo_participantes;')=='2','failed second enrollment left orphan guest'
 reset();legacy="INSERT INTO public.equipos(torneo_id,sede_id,nombre,creador_id,jugadores) VALUES(555,8,'Legacy','"+CAP+"'::uuid,'"+json.dumps([{'user_id':CAP,'nombre':'Legacy captain'}])+"'::jsonb) RETURNING jsonb_build_object('id',id);"
 report.append(race('new registration wins against concurrent legacy insert',call(CAP,'inscribir',**body),legacy,'23505'))
 reset();report.append(race('legacy registration wins against concurrent new registration',legacy,call(CAP,'inscribir',**body),'23505'))
 reset();created=json.loads(run(call(ADMIN,'inscribir',nombre='Guests',incluir_capitan=False,participantes=[{'tipo_identidad':'generico','nombre':'One'},{'tipo_identidad':'generico','nombre':'Two'}])));guest=created['equipo']['jugadores'][0]['participante_id']
 claims=[json.loads(run(call(user,'solicitar_vinculacion',participante_id=guest)))['solicitud']['id'] for user in [U3,U4]]
 report.append(race('only one account can win a guest identity claim',call(ADMIN,'resolver_vinculacion',solicitud_id=claims[0],decision='aprobar'),call(ADMIN,'resolver_vinculacion',solicitud_id=claims[1],decision='aprobar'),'55000'))
 assert run('SELECT count(*) FROM public.torneo_participantes WHERE ranking_oficial_elegible;')=='0'
finally:reset()
remaining=json.loads(run("SELECT json_build_object('participants',(SELECT count(*) FROM public.torneo_participantes),'claims',(SELECT count(*) FROM public.torneo_participante_vinculaciones),'teams',(SELECT count(*) FROM public.equipos),'points',(SELECT count(*) FROM public.tabla_puntos));"));assert not any(remaining.values())
print(json.dumps({'status':'PASS','cases':report,'remaining_mutations':remaining},indent=2))
