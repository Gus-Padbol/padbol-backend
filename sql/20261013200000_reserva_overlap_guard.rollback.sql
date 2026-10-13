BEGIN;
DROP TRIGGER IF EXISTS reservas_sin_solape ON public.reservas;
DROP FUNCTION IF EXISTS public.reservas_guardar_sin_solape();
DROP FUNCTION IF EXISTS public.reserva_intervalo_guard(text,text,text,integer);
COMMIT;
