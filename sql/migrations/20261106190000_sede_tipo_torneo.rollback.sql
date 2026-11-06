-- Recuperación SEGURA: aborta si ya existe una sede de torneo (no pierde datos).
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sedes WHERE tipo_sede = 'torneo') THEN
    RAISE EXCEPTION 'Hay sedes tipo torneo: no se restaura NOT NULL sin resolverlas antes.';
  END IF;
END $$;

ALTER TABLE public.sedes DROP CONSTRAINT IF EXISTS sedes_reserva_completa_si_reservable;
ALTER TABLE public.sedes
  ALTER COLUMN cantidad_canchas SET NOT NULL,
  ALTER COLUMN horario_apertura SET NOT NULL,
  ALTER COLUMN horario_cierre SET NOT NULL,
  ALTER COLUMN precio_por_reserva SET NOT NULL,
  ALTER COLUMN whatsapp_contacto SET NOT NULL;
ALTER TABLE public.sedes DROP CONSTRAINT IF EXISTS sedes_tipo_sede_valido;
ALTER TABLE public.sedes DROP COLUMN IF EXISTS tipo_sede;
COMMIT;
