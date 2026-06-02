-- Cron post-partido: flag de notificación enviada y vínculo opcional reserva → partido

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS notificacion_post_partido_enviada BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS partido_id BIGINT REFERENCES partidos_abiertos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reservas_cron_completadas
  ON reservas (estado, notificacion_post_partido_enviada, fecha)
  WHERE estado = 'confirmada';

COMMENT ON COLUMN reservas.notificacion_post_partido_enviada IS
  'Push post-partido enviado al capitán (cron reservas completadas)';
