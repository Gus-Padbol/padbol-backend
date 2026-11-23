-- Local rollback only; do not remove protection while linked resources exist.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.clases_ocurrencias) THEN RAISE EXCEPTION 'Reconcile class occupancy before removing booking guard'; END IF; END $$;
DROP TRIGGER clases_ocurrencia_reserva_guard ON public.reservas;
DROP FUNCTION public.clases_ocurrencia_reserva_guard();
