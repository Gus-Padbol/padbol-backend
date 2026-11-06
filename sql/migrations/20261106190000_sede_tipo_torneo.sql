-- Sede de tipo TORNEO: no reservable, sin exigir datos de reserva.
-- Forward NO destructivo: agrega discriminador, libera los cinco campos de reserva
-- y los mantiene OBLIGATORIOS para las sedes reservables mediante CHECK condicional.
BEGIN;

ALTER TABLE public.sedes
  ADD COLUMN IF NOT EXISTS tipo_sede text NOT NULL DEFAULT 'reservable';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sedes_tipo_sede_valido'
      AND conrelid = 'public.sedes'::regclass
  ) THEN
    ALTER TABLE public.sedes
      ADD CONSTRAINT sedes_tipo_sede_valido
      CHECK (tipo_sede IN ('reservable','torneo'));
  END IF;
END $$;

-- Los campos de reserva dejan de ser NOT NULL a nivel columna: la obligatoriedad
-- se conserva por CHECK solo para sedes reservables.
ALTER TABLE public.sedes
  ALTER COLUMN cantidad_canchas DROP NOT NULL,
  ALTER COLUMN horario_apertura DROP NOT NULL,
  ALTER COLUMN horario_cierre DROP NOT NULL,
  ALTER COLUMN precio_por_reserva DROP NOT NULL,
  ALTER COLUMN whatsapp_contacto DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sedes_reserva_completa_si_reservable'
      AND conrelid = 'public.sedes'::regclass
  ) THEN
    ALTER TABLE public.sedes
      ADD CONSTRAINT sedes_reserva_completa_si_reservable
      CHECK (
        tipo_sede = 'torneo'
        OR (
          cantidad_canchas IS NOT NULL
          AND horario_apertura IS NOT NULL
          AND horario_cierre IS NOT NULL
          AND precio_por_reserva IS NOT NULL
          AND whatsapp_contacto IS NOT NULL
        )
      );
  END IF;
END $$;

COMMIT;
