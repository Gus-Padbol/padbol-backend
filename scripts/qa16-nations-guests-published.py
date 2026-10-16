"""Prepare then coordinator-approved real HTTP15x4 Nations rehearsal; never39/41.
No account creation, no outbound messages, no production deployment. QAonly.
"""
import importlib.util,json,secrets,uuid,argparse
from datetime import datetime,timedelta,timezone
from pathlib import Path
spec=importlib.util.spec_from_file_location('planning_rehearsal',Path(__file__).with_name('qa16-selection-planning-published.py'));g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g);h=g.h
OUT=h.PROJECT_ROOT/'output/qa/revision_20261016/chivi/nations_published';OUT.mkdir(parents=True,exist_ok=True)
def prepare():
 p=OUT/'MANIFEST.json'
 if p.exists():return json.loads(p.read_text())
 old=json.loads((h.PROJECT_ROOT/'output/qa/ensayo_nations_juanpi_20261014/MANIFIESTO.json').read_text());prefix='qa16-nations-guests-'+secrets.token_hex(8);m={'prefix':prefix,'name':prefix.upper(),'actor':old['actor'],'sede_id':8,'torneo_id':None};p.write_text(json.dumps(m,indent=2));return m

def run(m,commit):
 assert Path.cwd().resolve()==h.CANONICAL
 if m['torneo_id']is not None:raise RuntimeError('Used manifest; inspect/cleanup before another run')
 health=h.need(*h.request(h.API+'/health'));assert health.get('release')==commit[:7]
 admin,anon=h.credentials();actor=h.need(*h.request(h.BASE+'/auth/v1/admin/users/'+m['actor']['id'],headers=admin));assert actor['email']==m['actor']['email']and actor['user_metadata'].get('qa_test')is True
 link=h.need(*h.request(h.BASE+'/auth/v1/admin/generate_link','POST',admin,{'type':'magiclink','email':m['actor']['email']}));hashed=link.get('hashed_token')or link.get('properties',{}).get('hashed_token');session=h.need(*h.request(h.BASE+'/auth/v1/verify','POST',{'apikey':anon},{'type':'magiclink','token_hash':hashed}));assert session['user']['id']==m['actor']['id'];headers={'Authorization':'Bearer '+session['access_token']}
 report={'status':'RUNNING','checks':[]};q=h.literal
 def check(name,passed):
  report['checks'].append({'name':name,'passed':bool(passed)});(OUT/'RESULT.json').write_text(json.dumps(report,indent=2));assert passed,name
 def sql(name,query):return h.sql('NATIONS_GUESTS_'+name,query)
 baseline=sql('BASELINE.sql',g.protected_baseline_sql())
 pre=sql('PREFLIGHT.sql',"SELECT(SELECT es_prueba FROM sedes WHERE id=8)qa,(SELECT role FROM user_roles WHERE user_id="+q(m['actor']['id'])+"::uuid AND sede_id=8)role,(SELECT id FROM canchas WHERE sede_id=8 AND deporte='padbol'AND estado='activa'ORDER BY id LIMIT 1)court;")[0];assert pre['qa']is True and pre['role']=='admin_club'and pre['court']
 (OUT/'CLEANUP_REVIEW.sql').write_text(g.cleanup(m))
 seeded=sql('PREPARE.sql',"INSERT INTO torneos(nombre,sede_id,created_by,estado,deporte,modalidad_plantel,formato_equipo,tipo_torneo,nivel_torneo,fecha_inicio,fecha_fin,costo_inscripcion,es_prueba)VALUES("+q(m['name'])+",8,"+q(m['actor']['id'])+"::uuid,'abierto','padbol','selecciones','dobles','grupos_knockout','internacional',current_date+40,current_date+41,0,true)RETURNING id,fecha_inicio,fecha_fin;")[0];tid=int(seeded['id']);assert tid not in(39,41);m['torneo_id']=tid;(OUT/'MANIFEST.json').write_text(json.dumps(m,indent=2))
 def api(path,method='GET',body=None,expected=200,auth=headers):
  status,data=h.request(h.API+path,method,auth,body);check(method+' '+path,status==expected);return data
 base=f'/api/torneos/{tid}';nc=base+'/nations-cup'
 def state():return api(nc)
 def action(name,extra=None,method='POST'):
  current=state();return api(nc+'/'+name,method,{'expected_revision':int(current['revision']),'request_id':str(uuid.uuid4()),**(extra or{})})
 def ties(current):
  for _ in range(5):
   if not current.get('ties'):return current
   current=action('desempates',{'tie_resolutions':[{'scope':t['scope'],'team_ids':t['team_ids'],'ordered_team_ids':sorted(t['team_ids'],key=int),'reason':'QA temporary fixture: explicit residual ordering solely for reproducible rehearsal.'}for t in current['ties']]})
  raise RuntimeError('Unresolved ties after bounded approvals')
 try:
  teams=[]
  for i in range(15):
   data=api(base+'/inscripciones-participantes','POST',{'request_id':str(uuid.uuid4()),'nombre':m['name']+' '+str(i+1),'participantes':[{'tipo_identidad':'generico','nombre':f'QA Nations {i+1}-{j+1}'}for j in range(4)]},201);teams.append(data['equipo'])
  groups=[[t['id']for t in teams[i:i+5]]for i in range(0,15,5)];countries=['AR','BR','UY','ES','IT','RO','FR','DE','PT','GB','NL','BE','SE','CH','CZ']
  config={'format':'nations_3x5','timezone':'Europe/Rome','reveal_at':(datetime.now(timezone.utc)+timedelta(days=39)).isoformat(),'rules':{'placement_policy':'group_seed','third_place_match':True,'minimum_rest_minutes':0},'country_by_team':{str(t['id']):countries[i]for i,t in enumerate(teams)}}
  action('config',{'config':config},'PUT');api(nc+'/publico',expected=404,auth={});hidden=api(nc+'/publico');check('private reveal stays hidden even QA operator public view',hidden.get('hidden')is True and hidden.get('teams')==[]and hidden.get('matches')==[]);action('aprobar-reglas',{'approved':True});current=action('sorteo',{'groups':groups});check('3x5 draw/30groups',len(current['groups'])==3 and len(current['matches'])==30)
  def schedule(matches,day):
   return action('programacion',{'matches':[{'partido_id':match['id'],'fecha_hora':str(day)+f'T{10+i//6:02}:{(i%6)*10:02}:00Z','court_id':pre['court'],'duration_minutes':5}for i,match in enumerate(matches)]},'PUT')
  def play(match,real_points=False):
   mid=match['id']
   for eid in[match['equipo_a_id'],match['equipo_b_id']]:
    team=next(t for t in teams if t['id']==eid);ids=[p['participante_id']for p in team['participants']];api(base+f'/partidos/{mid}/equipos/{eid}/alineacion','PUT',{'iniciales':ids[:2],'suplentes':ids[2:4],'expected_revision':0})
   marker=api(nc+f'/partidos/{mid}/marcador','POST',{});sid=str(uuid.UUID(marker['scoreboard_id']));fresh=api('/api/scoreboard/partidos/'+sid);check('exact4+4 sporting marker',len(fresh['equipo_a_jugadores'])==4 and len(fresh['equipo_b_jugadores'])==4)
   if real_points:
    for _ in range(48):scored=api('/api/scoreboard/partidos/'+sid+'/punto/A','POST',{})
    check('48 real points terminate2-0',scored.get('estado')in('terminado','finalizado')and scored.get('sets_a')==2 and scored.get('sets_b')==0)
   else:api(base+f'/partidos/{mid}/resultado','POST',{'goles_a':2,'goles_b':0,'historial_sets':[{'a':6,'b':0},{'a':6,'b':0}]})
   fresh=api('/api/scoreboard/partidos/'+sid);check('marker result synchronized',fresh.get('estado')in('terminado','finalizado')and fresh.get('sets_a')==2 and fresh.get('sets_b')==0)
   persisted=next(x for x in state()['matches']if x['id']==mid);check('actual sporting result persisted',persisted['estado']=='finalizado'and persisted['ganador_equipo_id']==match['equipo_a_id'])
  current=schedule(sorted(current['matches'],key=lambda x:x['id']),seeded['fecha_inicio'])
  for i,match in enumerate(sorted(current['matches'],key=lambda x:x['id'])):play(match,i==0)
  current=ties(state());current=action('avanzar');check('8qualifiers/38matches',len(current['qualified'])==8 and len(current['matches'])==38)
  seedmap={int(x['seed']):x['equipo_id']for x in current['qualified']};quarters=sorted([x for x in current['matches']if x.get('bracket_round')==1],key=lambda x:x['bracket_position']);check('quarter seeds1-8/4-5/2-7/3-6',[(x['equipo_a_id'],x['equipo_b_id'])for x in quarters]==[(seedmap[a],seedmap[b])for a,b in[(1,8),(4,5),(2,7),(3,6)]])
  knockout=sorted([x for x in current['matches']if x.get('bracket_round')],key=lambda x:(x['bracket_round'],x['bracket_position']));schedule(knockout,seeded['fecha_fin'])
  for template in knockout:
   match=next(x for x in state()['matches']if x['id']==template['id']);check('JS result propagated actual next opponents',match.get('equipo_a_id')is not None and match.get('equipo_b_id')is not None);play(match)
  current=ties(state());check('38finalresults',len(current['matches'])==38 and all(x['estado']=='finalizado'for x in current['matches']));closed=action('finalizar');check('Nations closure',closed.get('status')=='finalized'and len(closed.get('placements',[]))==15)
  evidence=sql('EVIDENCE.sql',f"SELECT(SELECT count(*)FROM torneo_partido_participacion WHERE torneo_id={tid})appearances,(SELECT count(*)FROM tabla_puntos WHERE torneo_id={tid})awards,(SELECT max(puntos)FROM tabla_puntos WHERE torneo_id={tid})maxpoints,(SELECT count(*)FROM equipos WHERE torneo_id={tid}AND cardinality(participantes_ranking)>0)official,(SELECT count(*)FROM torneo_participante_ranking_cierres WHERE torneo_id={tid}AND participantes='[]'::jsonb)snapshots;")[0];check('38evidence/15awards/300private/0official',evidence=={'appearances':38,'awards':15,'maxpoints':300,'official':0,'snapshots':15});api(nc+'/publico',expected=404,auth={});report['status']='PASS'
 finally:
  sql('CLEANUP_EXECUTED.sql',g.cleanup(m));res=sql('RESIDUALS.sql',f"SELECT(SELECT count(*)FROM torneos WHERE id={tid})tournaments,(SELECT count(*)FROM torneo_participantes WHERE torneo_id={tid})participants,(SELECT count(*)FROM scoreboard_partidos WHERE torneo_id={tid})markers;")[0];check('zeroQAresiduals',not any(res.values()));check('protected39/41alltables unchanged',sql('BASELINE_AFTER.sql',g.protected_baseline_sql())==baseline);(OUT/'RESULT.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'status':report['status'],'checks':len(report['checks'])}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');p.add_argument('--expected-commit');a=p.parse_args();m=prepare();(OUT/'CLEANUP_REVIEW.sql').write_text(g.cleanup(m))
 if a.execute:
  if not a.expected_commit:raise SystemExit('Expected released backend commit required')
  run(m,a.expected_commit)
 else:print('Prepared only; exact cleanup/release must be reviewed before --execute.')
