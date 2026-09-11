-- Read-only preflight. Metadata and aggregate counts only; no participant, token, message or row IDs.
BEGIN READ ONLY;
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname='public' AND tablename IN ('scoreboard_partidos','partidos')
ORDER BY tablename,indexname;
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid IN ('public.scoreboard_partidos'::regclass,'public.partidos'::regclass)
ORDER BY conrelid,conname;
WITH active AS (
 SELECT partido_torneo_id,count(*) AS amount FROM public.scoreboard_partidos
 WHERE partido_torneo_id IS NOT NULL
   AND coalesce(lower(btrim(estado)),'') NOT IN ('terminado','finalizado')
 GROUP BY partido_torneo_id
)
SELECT count(*) AS matches_with_active_scoreboard,
 count(*) FILTER (WHERE amount>1) AS matches_with_duplicate_active_scoreboards,
 coalesce(sum(amount-1) FILTER (WHERE amount>1),0) AS extra_active_scoreboards,
 coalesce(max(amount),0) AS largest_active_group FROM active;
SELECT count(*) FILTER (WHERE s.partido_torneo_id IS NOT NULL AND p.id IS NULL) AS dangling_scoreboard_links,
 count(*) FILTER (WHERE s.partido_torneo_id IS NOT NULL AND p.id IS NOT NULL
   AND (s.torneo_id IS DISTINCT FROM p.torneo_id OR s.sede_id IS DISTINCT FROM p.sede_id)) AS scoreboard_scope_mismatches
FROM public.scoreboard_partidos s LEFT JOIN public.partidos p ON p.id=s.partido_torneo_id;
WITH sources AS (
 SELECT partido_siguiente_id,partido_siguiente_slot,count(*) AS amount FROM public.partidos
 WHERE partido_siguiente_id IS NOT NULL GROUP BY partido_siguiente_id,partido_siguiente_slot
)
SELECT count(*) FILTER (WHERE amount>1) AS destination_slots_with_multiple_sources,
 coalesce(sum(amount-1) FILTER (WHERE amount>1),0) AS extra_source_links FROM sources;
COMMIT;
