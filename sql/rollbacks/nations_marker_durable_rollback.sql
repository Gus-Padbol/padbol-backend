-- Rollback seguro: desactiva captura automática sin borrar auditoría ni datos.
DROP TRIGGER IF EXISTS nations_marker_clock_bump ON scoreboard_partidos;
DROP TRIGGER IF EXISTS nations_marker_terminal_stamp ON scoreboard_partidos;
DROP FUNCTION IF EXISTS nations_marker_private.nations_marker_clock_bump();
DROP FUNCTION IF EXISTS nations_marker_private.nations_marker_terminal_stamp();
-- Se conservan nations_marker_match, receipts, audit, terminal y clock_revision.
-- No se crean, alteran ni revocan roles o grants.
