INSERT INTO public.sedes VALUES(1,'Europe/Rome');
INSERT INTO public.torneos VALUES
 (1,1,NULL,'knockout','en_curso',CURRENT_DATE-90,CURRENT_DATE,false),
 (2,1,NULL,'knockout','en_curso',CURRENT_DATE-90,CURRENT_DATE,false),
 (3,1,NULL,'knockout','en_curso',CURRENT_DATE+30,CURRENT_DATE+31,true),
 (4,1,NULL,'knockout','en_curso',CURRENT_DATE+30,CURRENT_DATE+31,false);
INSERT INTO public.partidos VALUES(10,1,'finalizado',2,3,NULL),(20,2,'finalizado',2,2,21);
INSERT INTO public.scoreboard_partidos VALUES
 (10,1,1,10,'terminado','synced',date_trunc('month',now())-interval '1 day'+interval '12 hours'),
 (20,2,1,20,'terminado','synced',date_trunc('month',now())-interval '1 day'+interval '12 hours');
UPDATE public.torneos SET estado='finalizado',fecha_fin=(date_trunc('month',now())-interval '1 day')::date WHERE id IN(1,2);
DO $$BEGIN
 IF (SELECT fecha_fin FROM public.torneos WHERE id=1) IS DISTINCT FROM (date_trunc('month',now())-interval '1 day')::date THEN RAISE EXCEPTION 'delayed scoreboard closure lost original month'; END IF;
 IF (SELECT fecha_fin FROM public.torneos WHERE id=2) IS DISTINCT FROM (now() AT TIME ZONE 'Europe/Rome')::date THEN RAISE EXCEPTION 'nonfinal scoreboard accepted arbitrary historical date'; END IF;
END$$;
UPDATE public.torneos SET estado='finalizado' WHERE id=3;
DO $$BEGIN
 IF (SELECT fecha_fin FROM public.torneos WHERE id=3)<>CURRENT_DATE+31 THEN RAISE EXCEPTION 'QA simulation lost planned date'; END IF;
 BEGIN UPDATE public.torneos SET estado='finalizado' WHERE id=4; RAISE EXCEPTION 'real future closure was allowed'; EXCEPTION WHEN SQLSTATE '22007' THEN NULL; END;
END$$;
-- Repeated closure cannot change the preserved source date.
UPDATE public.torneos SET estado='finalizado' WHERE id=1;
DO $$BEGIN
 IF (SELECT fecha_fin FROM public.torneos WHERE id=1)<>(date_trunc('month',now())-interval '1 day')::date THEN RAISE EXCEPTION 'retry changed source date'; END IF;
END$$;
SELECT '5 PostgreSQL calendar assertions PASS' AS result;
