import test from 'node:test';
import assert from 'node:assert/strict';
import { mapResenaPublicRow } from './resenasPublic.js';

test('public resena row excludes user_id and reserva_id', () => {
  const row = mapResenaPublicRow({
    id: 10,
    sede_id: 1,
    user_id: 'uuid-secret',
    reserva_id: 999,
    puntuacion: 5,
    comentario: 'Excelente',
    created_at: '2026-01-01T00:00:00Z',
    respuesta_admin: 'Gracias',
    respuesta_at: '2026-01-02T00:00:00Z',
    respuesta_por: 'admin-uuid',
    display_name: 'Ana',
    foto_url: 'https://cdn/a.jpg',
  });

  assert.equal(row.display_name, 'Ana');
  assert.equal(row.puntuacion, 5);
  assert.equal('user_id' in row, false);
  assert.equal('reserva_id' in row, false);
  assert.equal('respuesta_por' in row, false);
});
