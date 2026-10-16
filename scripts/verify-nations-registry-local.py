"""Reproducible isolated PostgreSQL16 proof; docker local only, never Supabase/prod.
Run from canonical backend: python3 scripts/verify-nations-registry-local.py --database <fresh_name>
Creates a fresh DB (refuses existing names), leaves it available for independent review.
Original national/Nations/thirdplace DDL plus additive QA16 migrations. Not a prod clone.
"""
import argparse,re,subprocess
from pathlib import Path
ROOT=Path('/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical')
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--container',default='jefe4-calendar-review-20261015');a=p.parse_args()
if Path.cwd().resolve()!=ROOT:raise SystemExit('Canonical working directory required')
if not re.fullmatch(r'[a-z][a-z0-9_]{0,55}',a.database):raise SystemExit('Invalid local database name')
base=['docker','--context','colima','exec','-i',a.container,'psql','-U','postgres','-v','ON_ERROR_STOP=1']
def run(sql,db='postgres'):
 subprocess.run(base+['-d',db],input=sql,text=True,check=True)
run('CREATE DATABASE '+a.database+';')
run("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN CREATE ROLE authenticated NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role')THEN CREATE ROLE service_role NOLOGIN;END IF;END$$;",a.database)
files=['sql/tests/20261016_selection_integrated_bootstrap.sql','sql/20261010150000_padbol_national_rosters_lineups.sql','sql/migrations/20261016100000_tournament_planning.sql','sql/migrations/20261016140000_tournament_generic_participants.sql','sql/migrations/20261016103000_generic_selection_lineups.sql','sql/migrations/20261016160000_generic_selection_compatibility.sql','sql/tests/20261016_nations_registry_bootstrap.sql','sql/20261011150000_nations_cup_event_plan.sql','sql/20261013120000_nations_third_place.sql','sql/migrations/20261016150000_participant_official_accreditation.sql','sql/migrations/20261016170000_nations_registered_participants.sql','sql/migrations/20261016180000_participant_ranking_closure_snapshot.sql','sql/migrations/20261016190000_sync_linked_scoreboard_final_result.sql']
for path in files:
 print('APPLY '+path,flush=True);run((ROOT/path).read_text(),a.database)
for path,prefix in [('sql/tests/20261016_scoreboard_reverse_sync_assertions.sql',''),('sql/tests/20261016_nations_registry_assertions.sql',''),('sql/tests/20261016_nations_registry_assertions.sql',"SET padbol.test_partial_roster='1';\n"),('sql/tests/20261016_participants_ranking_snapshot.sql',"SET padbol.test_partial_roster='';\n")]:
 print('TEST '+path+(' partial'if prefix else''),flush=True);run(prefix+(ROOT/path).read_text(),a.database)
run("SELECT(SELECT count(*)FROM torneo_participantes)participants,(SELECT count(*)FROM scoreboard_partidos)markers,(SELECT count(*)FROM partidos)matches,(SELECT count(*)FROM torneo_participante_ranking_cierres)snapshots;",a.database)
print('PASS local isolated registry/Nations38/marker reverse sync/immutable snapshot; all test transactions rolled back')
