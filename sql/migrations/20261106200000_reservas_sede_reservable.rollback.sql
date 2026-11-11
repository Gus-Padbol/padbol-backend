-- Rollback idempotente: se puede correr dos veces sin error.
BEGIN;
DROP TRIGGER IF EXISTS reservas_sede_reservable_trg ON public.reservas;
DROP FUNCTION IF EXISTS public.reserva_sede_reservable();
COMMIT;
