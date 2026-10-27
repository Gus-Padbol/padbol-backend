"""Coordinator-reviewed rehearsal only; no requests unless --execute --expected-commit.
One fresh QA selection event, four eight-person guest teams, manual knockout,
explicit start, declared four, scheduling, linked marker and result progression.
Never modifies39/41 or creates auth accounts. Credentials stay in memory.
"""
import importlib.util,json,secrets,uuid,argparse,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('qa16_helpers',Path(__file__).with_name('qa16-participants-published.py'));h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
OUT=h.PROJECT_ROOT/'output/qa/revision_20261016/chivi/published';OUT.mkdir(parents=True,exist_ok=True)
def prepare():
 p=OUT/'MANIFEST.json'
 if p.exists():return json.loads(p.read_text())
 previous=json.loads((h.PROJECT_ROOT/'output/qa/ensayo_nations_juanpi_20261014/MANIFIESTO.json').read_text());prefix='qa16-selection-'+secrets.token_hex(8)
 m={'prefix':prefix,'name':prefix.upper(),'actor':previous['actor'],'sede_id':8,'torneo_id':None};p.write_text(json.dumps(m,indent=2));return m

def cleanup(m):
 q=h.literal
 return """BEGIN;SET LOCAL lock_timeout='5s';DO $cleanup$
DECLARE tid bigint;eids bigint[];mids bigint[];sids uuid[];
BEGIN
 SELECT id INTO tid FROM torneos WHERE nombre="""+q(m['name'])+" AND created_by="+q(m['actor']['id'])+"::uuid AND sede_id=8 AND es_prueba IS TRUE;"+"""
 IF tid IS NULL OR tid IN(39,41,48) THEN RAISE EXCEPTION 'Exact QA fixture missing';END IF;
 PERFORM id FROM torneos WHERE id=tid FOR UPDATE;
 SELECT array_agg(id) INTO eids FROM equipos WHERE torneo_id=tid;
 SELECT array_agg(id) INTO mids FROM partidos WHERE torneo_id=tid;
 SELECT array_agg(id) INTO sids FROM scoreboard_partidos WHERE torneo_id=tid;
 IF EXISTS(SELECT1 FROM torneo_homologaciones WHERE torneo_id=tid) OR EXISTS(SELECT1 FROM torneo_participantes WHERE torneo_id=tid AND (ranking_oficial_elegible OR linked_user_id IS NOT NULL)) THEN RAISE EXCEPTION 'Official/linked unexpected state';END IF;
 IF EXISTS(SELECT1 FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)j WHERE e.torneo_id=tid AND (j->>'user_id' IS NOT NULL OR j->>'participante_id' IS NULL)) THEN RAISE EXCEPTION 'Guests differ from manifest';END IF;
 IF EXISTS(SELECT1 FROM partidos WHERE torneo_id<>tid AND (equipo_a_id=ANY(eids) OR equipo_b_id=ANY(eids) OR partido_siguiente_id=ANY(mids))) OR EXISTS(SELECT1 FROM scoreboard_partidos WHERE torneo_id IS DISTINCT FROM tid AND partido_torneo_id=ANY(mids)) THEN RAISE EXCEPTION 'Cross-fixture references';END IF;
 DELETE FROM scoreboard_historial_puntos WHERE partido_id=ANY(sids);
 DELETE FROM scoreboard_partidos WHERE id=ANY(sids);
 DELETE FROM games WHERE partido_id=ANY(mids);
 DELETE FROM torneo_partido_participacion WHERE torneo_id=tid;
 DELETE FROM torneo_partido_alineaciones WHERE torneo_id=tid;
 DELETE FROM torneo_participante_ranking_cierres WHERE torneo_id=tid;
 DELETE FROM torneo_participante_acreditaciones WHERE torneo_id=tid;
 DELETE FROM torneo_participante_vinculaciones WHERE torneo_id=tid;
 DELETE FROM torneo_participante_operaciones WHERE torneo_id=tid;
 DELETE FROM torneo_participante_equipos WHERE torneo_id=tid;
 DELETE FROM torneo_participantes WHERE torneo_id=tid;
 PERFORM set_config('padbol.nations_rpc','1',true);
 DELETE FROM torneo_nations_programacion WHERE torneo_id=tid;
 DELETE FROM torneo_nations_planes WHERE torneo_id=tid;
 DELETE FROM torneo_partidos_programacion WHERE torneo_id=tid;
 DELETE FROM torneo_fixture_planes WHERE torneo_id=tid;
 DELETE FROM tabla_puntos WHERE torneo_id=tid;
 UPDATE partidos SET partido_siguiente_id=NULL WHERE torneo_id=tid;
 DELETE FROM partidos WHERE torneo_id=tid;
 DELETE FROM equipos WHERE torneo_id=tid;
 DELETE FROM torneos WHERE id=tid;
END $cleanup$;COMMIT;""".replace('SELECT1','SELECT 1')

def protected_baseline_sql():
 tables=['torneos','equipos','partidos','tabla_puntos','torneo_partido_alineaciones','torneo_partido_participacion','torneo_nations_planes','torneo_nations_programacion','torneo_fixture_planes','torneo_partidos_programacion','torneo_participantes','torneo_participante_equipos','torneo_participante_operaciones','torneo_participante_vinculaciones','torneo_participante_acreditaciones','torneo_homologaciones','torneo_participante_ranking_cierres','scoreboard_partidos']
 rows=[]
 for table in tables:
  scope='id IN(39,41,48)' if table=='torneos' else 'torneo_id IN(39,41,48)'
  rows.append("SELECT '"+table+"' table_name,md5(coalesce(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)::text,'')) hash FROM public."+table+" x WHERE "+scope)
 rows.append("SELECT 'scoreboard_historial_puntos',md5(coalesce(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)::text,''))FROM scoreboard_historial_puntos x WHERE partido_id IN(SELECT id FROM scoreboard_partidos WHERE torneo_id IN(39,41,48))")
 rows.append("SELECT 'games',md5(coalesce(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)::text,''))FROM games x WHERE partido_id IN(SELECT id FROM partidos WHERE torneo_id IN(39,41,48))")
 return ' UNION ALL '.join(rows)+';'

def run(m,commit):
 if Path.cwd().resolve()!=h.CANONICAL:raise RuntimeError('Canonical directory required')
 if m['torneo_id'] is not None:raise RuntimeError('Manifest already used; do not retry writes')
 health=h.need(*h.request(h.API+'/health'));assert health.get('release')==commit[:7]
 admin,anon=h.credentials();actor=h.need(*h.request(h.BASE+'/auth/v1/admin/users/'+m['actor']['id'],headers=admin));assert actor['email']==m['actor']['email'] and actor['user_metadata'].get('qa_test') is True
 link=h.need(*h.request(h.BASE+'/auth/v1/admin/generate_link','POST',admin,{'type':'magiclink','email':m['actor']['email']}));hashed=link.get('hashed_token')or link.get('properties',{}).get('hashed_token');session=h.need(*h.request(h.BASE+'/auth/v1/verify','POST',{'apikey':anon},{'type':'magiclink','token_hash':hashed}));assert session['user']['id']==m['actor']['id'];headers={'Authorization':'Bearer '+session['access_token']}
 report={'status':'RUNNING','checks':[]}
 def check(name,passed):
  report['checks'].append({'name':name,'passed':bool(passed)});(OUT/'RESULT.json').write_text(json.dumps(report,indent=2));assert passed,name
 def sql(name,query):return h.sql('SELECTION_'+name,query)
 q=h.literal
 baseline=sql('BASELINE.sql',protected_baseline_sql())
 pre=sql('PREFLIGHT.sql',"SELECT (SELECT es_prueba FROM sedes WHERE id=8) qa,(SELECT role FROM user_roles WHERE user_id="+q(m['actor']['id'])+"::uuid AND sede_id=8) role,(SELECT id FROM canchas WHERE sede_id=8 AND deporte='padbol' AND estado='activa' ORDER BY id LIMIT1) court;".replace('LIMIT1','LIMIT 1'))[0];assert pre['qa']is True and pre['role']=='admin_club' and pre['court']
 (OUT/'CLEANUP_REVIEW.sql').write_text(cleanup(m))
 rows=sql('PREPARE.sql',"INSERT INTO torneos(nombre,sede_id,created_by,estado,deporte,modalidad_plantel,formato_equipo,tipo_torneo,nivel_torneo,fecha_inicio,fecha_fin,costo_inscripcion,es_prueba) VALUES("+q(m['name'])+",8,"+q(m['actor']['id'])+"::uuid,'abierto','padbol','selecciones','dobles','knockout','club_no_oficial',current_date+30,current_date+31,0,true)RETURNING id,fecha_inicio;");tid=int(rows[0]['id']);m['torneo_id']=tid;(OUT/'MANIFEST.json').write_text(json.dumps(m,indent=2));assert tid not in(39,41,48)
 def call(path,method='GET',body=None,expected=200):
  status,data=h.request(h.API+f'/api/torneos/{tid}'+path,method,headers,body);check(method+' '+path,status==expected);return data
 try:
  teams=[]
  for i in range(4):
   data=call('/inscripciones-participantes','POST',{'request_id':str(uuid.uuid4()),'nombre':m['name']+' '+str(i),'participantes':[{'tipo_identidad':'generico','nombre':f'QA guest{i}-{j}'}for j in range(8)]},201);teams.append(data['equipo'])
  pairings=[{'equipo_a_id':teams[0]['id'],'equipo_b_id':teams[1]['id']},{'equipo_a_id':teams[2]['id'],'equipo_b_id':teams[3]['id']}]
  plan=call('/planificar-fixture','POST',{'origen':'manual','cruces':pairings});check('planned stays open',plan.get('estado')=='abierto'and len(plan.get('partidos',[]))==3)
  first=plan['partidos'][0]['id'];call(f'/partidos/{first}/marcador','POST',{},409);call('/iniciar','POST',{})
  for index in range(3):
   match=sql('NEXT_MATCH.sql',f"SELECT id,equipo_a_id,equipo_b_id FROM partidos WHERE torneo_id={tid} AND estado IN('pendiente','programado')AND equipo_a_id IS NOT NULL AND equipo_b_id IS NOT NULL ORDER BY ronda,id LIMIT 1;")[0];mid=match['id']
   for eid in[match['equipo_a_id'],match['equipo_b_id']]:
    team=next(t for t in teams if t['id']==eid);ids=[p['participante_id']for p in team['participants'][:4]];call(f'/partidos/{mid}/equipos/{eid}/alineacion','PUT',{'iniciales':ids[:2],'suplentes':ids[2:],'expected_revision':0})
   call(f'/partidos/{mid}/programacion','PUT',{'court_id':pre['court'],'fecha_hora':str(rows[0]['fecha_inicio'])+f'T{10+index:02}:00:00Z','duration_minutes':30})
   marker=call(f'/partidos/{mid}/marcador','POST',{});check('linked marker',bool(marker.get('scoreboard_id')))
   call(f'/partidos/{mid}/resultado','POST',{'goles_a':2,'goles_b':0,'historial_sets':[{'a':6,'b':0},{'a':6,'b':0}]})
   synced=h.need(*h.request(h.API+'/api/scoreboard/partidos/'+str(marker['scoreboard_id']),headers=headers));check('marker reflects manual result',synced.get('estado')in('terminado','finalizado')and synced.get('sets_a')==2 and synced.get('sets_b')==0)
  closed=call('/finalizar','POST',{});check('closed via application',closed.get('torneo',{}).get('estado')=='finalizado')
  state=sql('EVIDENCE.sql',f"SELECT(SELECT count(*)FROM torneo_partido_participacion WHERE torneo_id={tid}) evidence,(SELECT count(*)FROM scoreboard_partidos WHERE torneo_id={tid} AND jsonb_array_length(equipo_a_jugadores)=4 AND jsonb_array_length(equipo_b_jugadores)=4) markers,(SELECT count(*)FROM equipos WHERE torneo_id={tid} AND cardinality(participantes_ranking)>0) official;")[0];check('three real matches4+4 evidence and0official',state['evidence']==3 and state['markers']==3 and state['official']==0);report['status']='PASS'
 finally:
  sql('CLEANUP_EXECUTED.sql',cleanup(m));remaining=sql('RESIDUALS.sql',f"SELECT(SELECT count(*)FROM torneos WHERE id={tid}) tournaments,(SELECT count(*)FROM torneo_participantes WHERE torneo_id={tid}) participants,(SELECT count(*)FROM scoreboard_partidos WHERE torneo_id={tid}) markers;")[0];check('zero fixture residuals',not any(remaining.values()));after=sql('BASELINE_AFTER.sql',protected_baseline_sql());check('protected39/41unchanged',after==baseline);(OUT/'RESULT.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'status':report['status'],'checks':len(report['checks'])}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');p.add_argument('--expected-commit');a=p.parse_args();m=prepare();(OUT/'CLEANUP_REVIEW.sql').write_text(cleanup(m))
 if a.execute:
  if not a.expected_commit:raise SystemExit('Expected deployed commit mandatory')
  run(m,a.expected_commit)
 else:print('Prepared only; coordinator must review cleanup and released commit before --execute.')
