-- Read only. Metadata and aggregate counts; no match, user, token or player identifiers.
BEGIN READ ONLY;
SELECT jsonb_build_object(
 'checked_at',clock_timestamp(),
 'active_index',(SELECT jsonb_build_object('name',c.relname,'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,
   'immediate',i.indimmediate,'definition',pg_get_indexdef(i.indexrelid),'predicate',pg_get_expr(i.indpred,i.indrelid))
   FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   WHERE i.indexrelid=to_regclass('public.idx_scoreboard_partidos_partido_torneo_activo')),
 'state_column',(SELECT jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
   'default',pg_get_expr(d.adbin,d.adrelid)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.scoreboard_partidos'::regclass AND a.attname='estado'),
 'tournament_scoreboards',(SELECT jsonb_build_object('total',count(*),'null_state',count(*) FILTER(WHERE estado IS NULL),
   'unsupported_state',count(*) FILTER(WHERE estado IS NOT NULL AND estado NOT IN('pendiente','en_curso','terminado','finalizado')),
   'canonical_active',count(*) FILTER(WHERE estado IN('pendiente','en_curso')))
   FROM public.scoreboard_partidos WHERE partido_torneo_id IS NOT NULL),
 'ambiguous_active_groups',(SELECT count(*) FROM(SELECT partido_torneo_id FROM public.scoreboard_partidos
   WHERE partido_torneo_id IS NOT NULL AND coalesce(lower(btrim(estado)),'') NOT IN('terminado','finalizado')
   GROUP BY partido_torneo_id HAVING count(*)>1) q)
) AS report;
COMMIT;
