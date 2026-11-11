# Pruebas de privacidad de planteles (Nations)

El test PGlite `nationsRosterPrivacy.sql.test.mjs` se retiró: usaba un **stub dummy** de la RPC
y quedó incompatible con el fail-closed del forward (que ahora aborta si no reconoce la firma).

La cobertura se movió al motor real, con el esquema extraído de producción:

- `rls_pg.sh` — 7 casos de `puede_leer_nations` (RLS): approval false, approval+reveal, reveal
  futuro, sin timezone, reveal_at inválido, torneo normal y alcance de capitán.
  Además verifica que aplicar el forward dos veces deja `pg_get_functiondef` **idéntico**.
- `repro_nations.sh` — 5 casos de la RPC real `gestionar_participantes_torneo` (catálogo).
- `rpc_schema_real.sql` — DDL real (263 tablas, 1082 constraints) extraído por catálogo.
- `rpc_participantes_real.sql` — definición real de la RPC en producción.

Ambos scripts crean un clúster temporal aislado (`listen_addresses=''`) y lo eliminan por `trap`.
