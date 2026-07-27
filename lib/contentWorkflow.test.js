import test from 'node:test';
import assert from 'node:assert/strict';
import { contentWorkflowInternals } from '../routes/contentAdmin.js';

const {
  buildPayload,
  mapDraftRow,
  validateContentTarget,
} = contentWorkflowInternals;

test('workflow accepts every native hub card and rejects unknown targets', () => {
  for (const key of [
    'reservar',
    'buscar_partido',
    'torneos',
    'rankings',
    'armar_partido',
    'comunidad',
    'perfil',
    'mis_partidos',
  ]) {
    assert.equal(validateContentTarget('hub', 'padbol', key), true);
  }
  assert.equal(validateContentTarget('hub', 'padbol', 'unknown'), false);
  assert.equal(validateContentTarget('ad', 'padbol', 'app_general'), true);
  assert.equal(validateContentTarget('ad', 'bad-sport', 'app_general'), false);
});

test('workflow normalizes a hub draft and requires a video URL', () => {
  const image = buildPayload('hub', 'padbol', 'reservar', {
    titulo: '  Reservar  ',
    subtitulo: ' Elegí sede ',
    media_type: 'image',
    imagen_url: ' https://example.com/card.jpg ',
  });
  assert.deepEqual(image.payload, {
    deporte: 'padbol',
    card_key: 'reservar',
    titulo: 'Reservar',
    subtitulo: 'Elegí sede',
    imagen_url: 'https://example.com/card.jpg',
    media_type: 'image',
    video_url: null,
    poster_url: null,
  });

  assert.equal(
    buildPayload('hub', 'padbol', 'reservar', { media_type: 'video' }).error,
    'Un video necesita su URL de video',
  );
});

test('workflow exposes editorial status without user identifiers', () => {
  assert.deepEqual(mapDraftRow({
    content_type: 'hub',
    deporte: 'padbol',
    item_key: 'reservar',
    payload: { titulo: 'Reserva' },
    status: 'pending_review',
    updated_by: 'private-user-id',
  }), {
    content_type: 'hub',
    deporte: 'padbol',
    item_key: 'reservar',
    payload: { titulo: 'Reserva' },
    status: 'pending_review',
    review_note: '',
    submitted_at: null,
    reviewed_at: null,
    published_at: null,
    updated_at: null,
  });
});
