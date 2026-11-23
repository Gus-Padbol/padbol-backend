-- Local rollback only. Refuse destructive rollback while occurrences exist.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.clases_ocurrencias) THEN RAISE EXCEPTION 'Archive/reconcile class occurrences before rollback'; END IF; END $$;
DROP TRIGGER IF EXISTS clases_ocurrencia_reserva_guard ON public.reservas;
DROP FUNCTION IF EXISTS public.clases_ocurrencia_reserva_guard();
DROP TRIGGER IF EXISTS clases_ocurrencia_footprint_guard ON public.clases;
DROP FUNCTION IF EXISTS public.clases_ocurrencia_footprint_guard();
DROP FUNCTION public.clases_ocurrencia_comando(text,bigint,uuid,date,time,bigint,bigint,text,boolean,text);
DROP TABLE public.clases_accesos;
ALTER TABLE public.inscripciones_clases DROP COLUMN ocurrencia_id;
DROP TABLE public.clases_ocurrencias;
