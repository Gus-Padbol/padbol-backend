import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PGlite();
try {
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE public.sedes(id bigint PRIMARY KEY, timezone text);
 CREATE TABLE public.torneos(id bigint, estado text, fecha_fin date, sede_id bigint, plan_nations jsonb);
 CREATE TABLE public.partidos(torneo_id bigint);
 CREATE TABLE public.equipos(id bigint, inscripcion_estado text, plantel_revision integer);
 INSERT INTO sedes VALUES (1,'America/New_York');
 CREATE FUNCTION public.gestionar_participantes_torneo(bigint,uuid,text,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
 DECLARE t torneos; open_registration boolean; BEGIN SELECT * INTO t FROM torneos WHERE id=$1;
 open_registration:=coalesce(t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion'),false)
  AND NOT EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id);
 RETURN jsonb_build_object('can_register',open_registration); END $f$;
 CREATE FUNCTION public.guardar_plantel_seleccion(bigint,bigint,uuid,boolean,text,text,integer,boolean,uuid[],bigint) RETURNS jsonb LANGUAGE plpgsql AS $f$
 DECLARE t torneos; e equipos; result_status text:='saved'; p_accion ALIAS FOR $5; p_cupo ALIAS FOR $7; BEGIN
 SELECT * INTO t FROM torneos WHERE id=$1; SELECT * INTO e FROM equipos WHERE id=$2;
 IF p_accion='crear' THEN
  IF p_cupo<4 THEN RAISE EXCEPTION 'capacity'; END IF;
 ELSE
  IF p_accion='confirmar' THEN
   IF e.inscripcion_estado='confirmado' THEN result_status:='idempotent'; ELSE UPDATE public.equipos SET inscripcion_estado='confirmado',plantel_revision=plantel_revision+1 WHERE id=e.id RETURNING * INTO e; END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('status',result_status); END $f$;
 INSERT INTO torneos VALUES(1,'abierto',current_date-2,1,NULL),(2,'abierto',current_date+2,1,NULL);
 INSERT INTO equipos VALUES (1,'pendiente',1),(2,'confirmado',1);`);
 const migration=await readFile(new URL('../20261021130000_tournament_registration_date.sql',import.meta.url),'utf8');
 await db.exec(migration);
 const rows=await db.query(`SELECT id, public.gestionar_participantes_torneo(id,'00000000-0000-4000-8000-000000000001','listar','{}')->>'can_register' AS allowed FROM torneos ORDER BY id`);
 assert.deepEqual(rows.rows.map(x=>x.allowed),['false','true']);
 const args = "1,1,'00000000-0000-4000-8000-000000000001',false,'confirmar','x',4,false,ARRAY[]::uuid[],1";
 await assert.rejects(db.query(`SELECT public.guardar_plantel_seleccion(${args})`), /Registration closed/);
 const retry=await db.query(`SELECT public.guardar_plantel_seleccion(${args.replace('1,1,','1,2,')}) AS result`);
 assert.equal(retry.rows[0].result.status,'idempotent');
 await assert.rejects(db.query(`SELECT public.guardar_plantel_seleccion(1,1,'00000000-0000-4000-8000-000000000001',false,'crear','x',4,false,ARRAY[]::uuid[],1)`), /Registration closed/);
 console.log('PASS: fecha vencida rechaza registros, mantiene reintentos confirmados y respeta futuros');
} finally { await db.close(); }
