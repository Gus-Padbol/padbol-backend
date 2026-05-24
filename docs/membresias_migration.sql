-- Membresías de usuario (plan activo por jugador)
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

CREATE TABLE IF NOT EXISTS membresias (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  email TEXT,
  plan_id TEXT NOT NULL DEFAULT 'gratuito',
  estado TEXT NOT NULL DEFAULT 'activa',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membresias_plan_id ON membresias (plan_id);

COMMENT ON TABLE membresias IS 'Plan de membresía activo por usuario (gratuito, premium, elite)';
COMMENT ON COLUMN membresias.plan_id IS 'gratuito | premium | elite';
