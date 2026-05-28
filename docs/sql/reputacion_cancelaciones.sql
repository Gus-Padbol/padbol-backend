-- Reputación por cancelaciones tardías de reservas.
-- Ejecutar en Supabase SQL Editor (idempotente).

CREATE TABLE IF NOT EXISTS public.cancelaciones_jugador (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  reserva_id integer NOT NULL,
  horas_anticipacion numeric(10, 2),
  penaliza boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cancelaciones_jugador_user_created
  ON public.cancelaciones_jugador (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cancelaciones_jugador_penaliza_30d
  ON public.cancelaciones_jugador (user_id, created_at DESC)
  WHERE penaliza = true;

CREATE TABLE IF NOT EXISTS public.suspensiones_jugador (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  suspendido_hasta timestamptz NOT NULL,
  levantada_at timestamptz,
  levantada_por uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suspensiones_jugador_user_activa
  ON public.suspensiones_jugador (user_id, suspendido_hasta DESC)
  WHERE levantada_at IS NULL;

COMMENT ON TABLE public.cancelaciones_jugador IS 'Historial de cancelaciones de reservas por jugador (reputación).';
COMMENT ON TABLE public.suspensiones_jugador IS 'Suspensiones temporales por acumulación de cancelaciones penalizantes.';
