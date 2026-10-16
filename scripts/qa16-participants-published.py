"""Prepared production rehearsal: exact synthetic fixture only. No automatic deployment.
Run from canonical backend only, after coordinator confirms migration/release/review.
Tokens and generated magic links stay in memory. Never logs bodies or credentials.
"""
import argparse,ast,base64,json,secrets,subprocess,time,uuid,urllib.request,urllib.error
from pathlib import Path
CANONICAL=Path('/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical')
PROJECT_ROOT=Path('/Users/padbol2022/.codex/.chatgpt-projects/g-p-6aa1d73121088191b6fb2d58d70d3d6c')
OUT=PROJECT_ROOT/'output/qa/revision_20261016/participants/published';OUT.mkdir(parents=True,exist_ok=True)
PROJECT='vpldffhsxhgnmitiikof';BASE='https://'+PROJECT+'.supabase.co';API='https://padbol-backend.onrender.com'
RUNTIME=PROJECT_ROOT/'output/qa/respaldo_20261011/nations-release/runtime'
SOURCE=PROJECT_ROOT/'output/qa/cierre_20261013/NATIONS_HTTP_REAL.py'
for node in ast.parse(SOURCE.read_text()).body:
 if isinstance(node,ast.FunctionDef) and node.name in ['request','credentials','literal']:exec(compile(ast.Module(body=[node],type_ignores=[]),str(SOURCE),'exec'))
def need(code,data):
 if code not in (200,201,204):raise RuntimeError('Service status '+str(code))
 return data
def sql(name,query):
 if (RUNTIME/'supabase/.temp/project-ref').read_text().strip()!=PROJECT:raise RuntimeError('Project mismatch')
 file=OUT/name;file.write_text(query)
 p=subprocess.run(['supabase','db','query','--linked','--workdir',str(RUNTIME),'--file',str(file),'--output','json'],capture_output=True,text=True,timeout=120)
 if p.returncode:raise RuntimeError('SQL '+name+' failed; diagnostics withheld')
 return json.loads(p.stdout[p.stdout.index('{'):])['rows']
def prepare():
 path=OUT/'MANIFEST.json'
 if path.exists():return json.loads(path.read_text())
 previous=json.loads((PROJECT_ROOT/'output/qa/ensayo_nations_juanpi_20261014/MANIFIESTO.json').read_text());actor=previous['actor']
 assert actor['id']=='22482ee7-d6f3-4ddf-9605-1d492c8ea92b'
 prefix='qa16-participants-'+secrets.token_hex(8)
 m={'prefix':prefix,'name':prefix.upper(),'actor':actor,'venue_id':8,'venue_name':previous['venue_name'],'torneo_id':None,
 'users':[{'id':str(uuid.uuid4()),'email':prefix+'-'+label+'@example.invalid','nombre':'QA16 '+label} for label in ['captain','claimant']]}
 path.write_text(json.dumps(m,indent=2));return m

def cleanup(m):
 q=literal;users=m['users'];ids=','.join(q(p['id'])+'::uuid' for p in users);actor=q(m['actor']['id'])+'::uuid';name=q(m['name']);prefix=q(m['prefix'])
 return """BEGIN;
SET LOCAL lock_timeout='5s';
DO $cleanup$
DECLARE tid bigint; eids bigint[]; mids bigint[];
BEGIN
 SELECT id INTO tid FROM public.torneos WHERE nombre="""+name+" AND sede_id=8 AND created_by="+actor+";\n"+""" IF tid IS NULL OR tid IN(39,41) THEN RAISE EXCEPTION 'Exact temporary tournament missing';END IF;
 PERFORM id FROM public.torneos WHERE id=tid AND es_prueba IS TRUE FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Fixture QA marker missing';END IF;
 SELECT array_agg(id) INTO eids FROM public.equipos WHERE torneo_id=tid;
 SELECT array_agg(id) INTO mids FROM public.partidos WHERE torneo_id=tid;
 IF EXISTS(SELECT 1 FROM public.tabla_puntos WHERE torneo_id=tid) OR EXISTS(SELECT 1 FROM public.torneo_homologaciones WHERE torneo_id=tid)
 OR EXISTS(SELECT 1 FROM public.torneo_participante_acreditaciones WHERE torneo_id=tid AND estado='aprobado')
 OR EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE torneo_id=tid OR partido_torneo_id=ANY(mids))
 OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=tid AND (estado NOT IN('pendiente','programado') OR ganador_equipo_id IS NOT NULL))
 THEN RAISE EXCEPTION 'Unexpected score/official review, preserve fixture for investigation';END IF;
 IF (SELECT count(*) FROM auth.users WHERE id IN("""+ids+") AND raw_app_meta_data->>'qa_fixture'="+prefix+")<>2 THEN RAISE EXCEPTION 'Exact synthetic account ownership missing';END IF;\n"+""" IF EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id IS DISTINCT FROM tid AND (equipo_a_id=ANY(eids) OR equipo_b_id=ANY(eids) OR partido_siguiente_id=ANY(mids)))
 OR EXISTS(SELECT 1 FROM public.torneo_participante_equipos WHERE torneo_id IS DISTINCT FROM tid AND equipo_id=ANY(eids))
 OR EXISTS(SELECT 1 FROM public.torneo_participantes WHERE torneo_id IS DISTINCT FROM tid AND linked_user_id IN("""+ids+"))\n"+" OR EXISTS(SELECT 1 FROM public.equipos e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.jugadores)='array' THEN e.jugadores ELSE '[]'::jsonb END) j WHERE e.torneo_id IS DISTINCT FROM tid AND lower(j->>'user_id') IN("+','.join(q(p['id']) for p in users)+")) THEN RAISE EXCEPTION 'Cross-fixture reference';END IF;\n"+""" DELETE FROM public.torneo_participante_ranking_cierres WHERE torneo_id=tid;
 DELETE FROM public.torneo_participante_acreditaciones WHERE torneo_id=tid;
 DELETE FROM public.torneo_participante_vinculaciones WHERE torneo_id=tid;
 DELETE FROM public.torneo_participante_operaciones WHERE torneo_id=tid;
 DELETE FROM public.torneo_participante_equipos WHERE torneo_id=tid;
 DELETE FROM public.torneo_participantes WHERE torneo_id=tid;
 DELETE FROM public.torneo_partidos_programacion WHERE torneo_id=tid;
 DELETE FROM public.torneo_fixture_planes WHERE torneo_id=tid;
 DELETE FROM public.torneo_nations_programacion WHERE torneo_id=tid;
 DELETE FROM public.torneo_nations_planes WHERE torneo_id=tid;
 UPDATE public.partidos SET partido_siguiente_id=NULL WHERE torneo_id=tid;
 DELETE FROM public.partidos WHERE torneo_id=tid;
 DELETE FROM public.equipos WHERE torneo_id=tid;
 DELETE FROM public.torneos WHERE id=tid;
 DELETE FROM public.jugadores_perfil WHERE user_id IN("""+ids+");\n DELETE FROM auth.refresh_tokens WHERE user_id IN("+','.join(q(p['id']) for p in users)+");\n DELETE FROM auth.users WHERE id IN("+ids+");\nEND $cleanup$;\nCOMMIT;\n"

def run(m,expected_commit):
 assert Path.cwd().resolve()==CANONICAL
 health=need(*request(API+'/health'));assert health.get('status')=='ok' and health.get('release')==expected_commit[:7],'Expected deployed commit absent'
 admin,anon=credentials();actor=m['actor'];u=need(*request(BASE+'/auth/v1/admin/users/'+actor['id'],headers=admin));assert u['email']==actor['email'] and u['user_metadata'].get('qa_test') is True
 rows=sql('PRECONDITIONS_READONLY.sql',"SELECT (SELECT es_prueba FROM public.sedes WHERE id=8) AS qa_venue,(SELECT role FROM public.user_roles WHERE user_id="+literal(actor['id'])+"::uuid AND sede_id=8) AS role;");assert rows[0]['qa_venue'] is True and rows[0]['role']=='admin_club'
 def jwt(account):
  link=need(*request(BASE+'/auth/v1/admin/generate_link','POST',admin,{'type':'magiclink','email':account['email']}));hashed=link.get('hashed_token') or link.get('properties',{}).get('hashed_token');assert hashed
  session=need(*request(BASE+'/auth/v1/verify','POST',{'apikey':anon},{'type':'magiclink','token_hash':hashed}));assert session['user']['id']==account['id'];return {'Authorization':'Bearer '+session['access_token']}
 headers=jwt(actor)
 if m['torneo_id'] is not None:raise RuntimeError('Rehearsal manifest already used: review/cleanup before any rerun')
 protected_query=(PROJECT_ROOT/'output/qa/revision_20261016/participants/PROTECTED_SNAPSHOT.sql').read_text()
 protected_before=sql('PROTECTED_BEFORE.sql',protected_query)[0]['protected']
 (OUT/'PROTECTED_BEFORE.json').write_text(json.dumps(protected_before,indent=2))
 # The complete cleanup is persisted BEFORE creating any fixture data.
 (OUT/'CLEANUP_REVIEW.sql').write_text(cleanup(m))
 q=literal;prep="BEGIN;DO $seed$ DECLARE tid bigint;BEGIN "
 for p in m['users']:prep+="IF EXISTS(SELECT 1 FROM auth.users WHERE id="+q(p['id'])+"::uuid OR email="+q(p['email'])+") THEN RAISE EXCEPTION 'Fresh UUID/email collision';END IF;"
 prep+="INSERT INTO public.torneos(nombre,sede_id,created_by,estado,deporte,modalidad_plantel,formato_equipo,tipo_torneo,nivel_torneo,fecha_inicio,fecha_fin,costo_inscripcion,es_prueba) VALUES("+q(m['name'])+",8,"+q(actor['id'])+"::uuid,'abierto','padbol','dobles','dobles','knockout','club_no_oficial',current_date+2,current_date+3,0,true) RETURNING id INTO tid;IF tid IN(39,41) THEN RAISE EXCEPTION 'Protected event';END IF;"
 for p in m['users']:
  meta="jsonb_build_object('qa_test',true,'qa_fixture',"+q(m['prefix'])+",'qa_torneo_id',tid,'qa_sede_id',8)"
  prep+="INSERT INTO auth.users(id,email,aud,role,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES("+q(p['id'])+"::uuid,"+q(p['email'])+",'authenticated','authenticated',now(),"+meta+","+meta+",now(),now()); INSERT INTO public.jugadores_perfil(user_id,email,nombre,apellido,fecha_nacimiento,genero,pais,es_prueba) VALUES("+q(p['id'])+"::uuid,"+q(p['email'])+","+q(p['nombre'])+",'QA','1990-01-01','masculino','Italia',true);"
 prep+="END $seed$;COMMIT;SELECT id FROM public.torneos WHERE nombre="+q(m['name'])+" AND sede_id=8;"
 m['torneo_id']=int(sql('PREPARATION.sql',prep)[0]['id']);(OUT/'MANIFEST.json').write_text(json.dumps(m,indent=2));tid=m['torneo_id'];report={'status':'RUNNING','torneo_id':tid,'checks':[]}
 def check(name,passed,**safe):
  report['checks'].append({'name':name,'passed':bool(passed),**safe});(OUT/'RESULT.json').write_text(json.dumps(report,indent=2));assert passed,name
 def call(auth,path,method='GET',body=None,expected=200):
  start=time.monotonic();status,data=request(API+f'/api/torneos/{tid}'+path,method,auth,body);check(method+' '+path,status==expected,status=status,milliseconds=round((time.monotonic()-start)*1000));return data
 try:
  cap=jwt(m['users'][0]);claim=jwt(m['users'][1]);req=lambda:str(uuid.uuid4())
  call({},'/participantes',expected=401)
  club=call(headers,'/inscripciones-participantes','POST',{'request_id':req(),'nombre':m['name']+' Club','participantes':[{'tipo_identidad':'generico','nombre':'QA Guest One'},{'tipo_identidad':'generico','nombre':'QA Guest Two'}]},201)
  check('administrator not enrolled automatically',all(not p.get('user_id') for p in club['equipo']['participants']))
  for suffix in ['Extra A','Extra B']:
   call(headers,'/inscripciones-participantes','POST',{'request_id':req(),'nombre':m['name']+' '+suffix,'participantes':[{'tipo_identidad':'generico','nombre':'QA '+suffix+' One'},{'tipo_identidad':'generico','nombre':'QA '+suffix+' Two'}]},201)

  body={'request_id':req(),'nombre':m['name']+' Captain','incluir_capitan':False,'participantes':[{'tipo_identidad':'plaza_pendiente'}]};captain=call(cap,'/inscripciones-participantes','POST',body,201)
  check('captain registered with pending colleague',captain['equipo']['participants'][0]['user_id']==m['users'][0]['id'] and not captain['equipo']['habilitacion_deportiva']['habilitado'])
  retry=call(cap,'/inscripciones-participantes','POST',body);check('idempotent team',retry['equipo']['id']==captain['equipo']['id'])
  call(cap,'/inscripciones-participantes','POST',{**body,'request_id':req()},409)
  planned=call(headers,'/planificar-fixture','POST',{});check('fixture planning before sporting completion',planned.get('estado')=='abierto' and planned.get('total')==3 and len(planned.get('partidos',[]))==3)
  call(headers,'/iniciar','POST',{},409)
  pending=captain['equipo']['participants'][1]['participante_id'];call(cap,'/participantes/'+pending,'PATCH',{'request_id':req(),'nombre':'QA Named Colleague','tipo_identidad':'generico'})
  fresh=call(cap,'/participantes');check('persisted participant actions',any(p['id']==pending and p.get('can_edit') for t in fresh['teams'] for p in t['participants']))
  guest=club['equipo']['participants'][0]['participante_id'];asked=call(claim,'/participantes/'+guest+'/vinculacion','POST',{'request_id':req(),'user_id':actor['id']},201)
  linked=call(headers,'/vinculaciones/'+asked['solicitud']['id']+'/resolver','POST',{'request_id':req(),'decision':'aprobar'});check('claim uses actual authenticated account',linked['participante']['linked_user_id']==m['users'][1]['id'] and not linked['participante']['ranking_oficial_elegible'])
  official=call(claim,'/participantes/'+guest+'/acreditacion','POST',{'request_id':req()},201)
  call(headers,'/acreditaciones/'+official['solicitud']['id']+'/resolver','POST',{'request_id':req(),'decision':'aprobar'},403)
  catalog=call(headers,'/participantes');check('QA official accreditation unavailable',not catalog['can_homologate'] and all(not p['ranking_oficial_elegible'] for p in catalog['participants']))
  call(headers,'/iniciar','POST',{});call(cap,'/participantes/'+pending,'PATCH',{'request_id':req(),'nombre':'Forbidden late edit'},409)
  report['status']='PASS'
 finally:
  sql('CLEANUP_EXECUTED.sql',cleanup(m));checks=sql('RESIDUALS.sql',"SELECT (SELECT count(*) FROM public.torneos WHERE id="+str(tid)+") AS tournaments,(SELECT count(*) FROM public.torneo_participantes WHERE torneo_id="+str(tid)+") AS participants,(SELECT count(*) FROM auth.users WHERE id IN("+','.join(q(u['id'])+'::uuid' for u in m['users'])+")) AS accounts;")[0];check('guarded cleanup',not any(checks.values()));report['cleanup']=checks;protected_after=sql('PROTECTED_AFTER.sql',protected_query)[0]['protected'];check('protected39/41 complete rows unchanged',protected_after==protected_before);(OUT/'PROTECTED_AFTER.json').write_text(json.dumps(protected_after,indent=2));(OUT/'RESULT.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'status':report['status'],'checks':len(report['checks']),'torneo_id':tid}))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');parser.add_argument('--expected-commit');args=parser.parse_args();manifest=prepare();(OUT/'CLEANUP_REVIEW.sql').write_text(cleanup(manifest))
 if args.execute:
  if not args.expected_commit:raise SystemExit('Expected released backend commit is mandatory')
  run(manifest,args.expected_commit)
 else:print('Prepared synthetic manifest and guarded cleanup only; no service requests or data changes.')
