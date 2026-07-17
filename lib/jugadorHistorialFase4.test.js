import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORIAL_COMUNIDAD_PREVIEW_MAX,
  assertNoPrivateLeak,
  buildComunidadTextoPreview,
  filterHistorialEvents,
  paginateHistorialEvents,
  parseHistorialTipos,
  tryNormalizeComunidadEvent,
} from './jugadorHistorialDomain.js';
import {
  fetchComunidadHistorialEvents,
  getJugadorHistorial,
} from './jugadorHistorialService.js';

const U1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

test('1. Normalización correcta de publicación propia', () => {
  const r = tryNormalizeComunidadEvent({
    id: 42,
    autor_user_id: U1,
    texto: 'Hola Comunidad',
    sede_id: 3,
    visibilidad: 'publica',
    estado: 'activa',
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-01T10:00:00.000Z',
  }, { likes_count: 2, comentarios_count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.event.id, 'comunidad:42');
  assert.equal(r.event.tipo, 'comunidad');
  assert.equal(r.event.titulo, 'Publicación');
  assert.equal(r.event.visibilidad, 'privada');
  assert.equal(r.event.referencia.tipo, 'comunidad_publicacion');
  assert.equal(r.event.referencia.id, '42');
  assert.equal(r.event.payload.texto_preview, 'Hola Comunidad');
  assert.equal(r.event.payload.visibilidad_publicacion, 'publica');
  assert.equal(r.event.resumen, 'Publicaste en la Comunidad');
});

function createFase4Mock({
  publicaciones = [],
  reacciones = [],
  comentarios = [],
  failTable = null,
  touched = null,
} = {}) {
  return {
    from(table) {
      if (touched) touched.add(table);
      const state = { filters: {}, inValues: null, limit: null };
      const api = {
        select() { return api; },
        eq(col, val) { state.filters[col] = val; return api; },
        in(col, vals) { state.inValues = { col, vals }; return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        then(resolve) {
          Promise.resolve().then(() => {
            if (failTable === table) {
              return { data: null, error: { message: 'boom fase4', code: 'XX' } };
            }
            if (table === 'comunidad_publicaciones') {
              let rows = [...publicaciones];
              if (state.filters.autor_user_id) {
                rows = rows.filter((r) => r.autor_user_id === state.filters.autor_user_id);
              }
              if (state.filters.estado) {
                rows = rows.filter((r) => r.estado === state.filters.estado);
              }
              return { data: rows.slice(0, state.limit || rows.length), error: null };
            }
            if (table === 'comunidad_reacciones') {
              let rows = [...reacciones];
              if (state.inValues?.col === 'publicacion_id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((r) => set.has(String(r.publicacion_id)));
              }
              return { data: rows, error: null };
            }
            if (table === 'comunidad_comentarios') {
              let rows = [...comentarios];
              if (state.filters.estado) {
                rows = rows.filter((r) => r.estado === state.filters.estado);
              }
              if (state.inValues?.col === 'publicacion_id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((r) => set.has(String(r.publicacion_id)));
              }
              return { data: rows, error: null };
            }
            return { data: [], error: null };
          }).then(resolve);
        },
      };
      return api;
    },
  };
}

test('2. Solo devuelve publicaciones del usuario autenticado', async () => {
  const db = createFase4Mock({
    publicaciones: [
      {
        id: 1, autor_user_id: U1, texto: 'mia', visibilidad: 'publica', estado: 'activa',
        created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
      },
      {
        id: 2, autor_user_id: U2, texto: 'ajena', visibilidad: 'publica', estado: 'activa',
        created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
      },
    ],
  });
  const { events } = await fetchComunidadHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.publicacion_id, '1');
});

test('3. No devuelve publicaciones de otros usuarios', async () => {
  const db = createFase4Mock({
    publicaciones: [{
      id: 9, autor_user_id: U2, texto: 'ajena', visibilidad: 'publica', estado: 'activa',
      created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    }],
  });
  const { events } = await fetchComunidadHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 0);
});

test('4. Publicación eliminada no aparece', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'eliminada', created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'eliminada');
});

test('5. Publicación moderada u oculta no aparece', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'ocultada', created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ocultada');
});

test('6. Publicación sin fecha válida se excluye', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sin_fecha');
});

test('7. occurred_at usa created_at', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa',
    created_at: '2026-06-01T08:00:00.000Z',
    updated_at: '2026-07-01T08:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.occurred_at, '2026-06-01T08:00:00.000Z');
});

test('8. updated_at no altera la fecha histórica', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa',
    created_at: '2026-06-01T08:00:00.000Z',
    updated_at: '2026-08-01T08:00:00.000Z',
  });
  assert.equal(r.event.occurred_at, '2026-06-01T08:00:00.000Z');
  assert.notEqual(r.event.occurred_at, '2026-08-01T08:00:00.000Z');
});

test('9. Publicación editada sigue generando un solo evento', () => {
  const r = tryNormalizeComunidadEvent({
    id: 7, texto: 'editada', estado: 'activa',
    created_at: '2026-06-01T08:00:00.000Z',
    updated_at: '2026-06-02T08:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.id, 'comunidad:7');
  assert.equal(r.event.payload.editada, true);
  assert.equal(r.event.resumen, 'Editaste una publicación');
});

test('10. texto_preview respeta longitud máxima', () => {
  const long = 'a'.repeat(HISTORIAL_COMUNIDAD_PREVIEW_MAX + 40);
  const preview = buildComunidadTextoPreview(long);
  assert.equal(Array.from(preview).length, HISTORIAL_COMUNIDAD_PREVIEW_MAX);
});

test('11. texto_preview maneja correctamente Unicode', () => {
  const text = `${'😀'.repeat(10)} padbol`;
  const preview = buildComunidadTextoPreview(text, 5);
  assert.equal(preview, '😀'.repeat(5));
  assert.equal(Array.from(preview).length, 5);
});

test('12. No se devuelve HTML o payload inseguro sin sanitización', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1,
    texto: '<script>alert(1)</script>Hola <b>mundo</b>',
    estado: 'activa',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.texto_preview.includes('<'), false);
  assert.equal(r.event.payload.texto_preview.includes('script'), false);
  assert.match(r.event.payload.texto_preview, /Hola/);
});

test('13. likes_count se normaliza correctamente cuando existe', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa', created_at: '2026-07-01T00:00:00Z',
  }, { likes_count: 4 });
  assert.equal(r.event.payload.likes_count, 4);
});

test('14. comentarios_count se normaliza correctamente cuando existe', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa', created_at: '2026-07-01T00:00:00Z',
  }, { comentarios_count: 3 });
  assert.equal(r.event.payload.comentarios_count, 3);
});

test('15. Contadores inexistentes devuelven null', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa', created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.event.payload.likes_count, null);
  assert.equal(r.event.payload.comentarios_count, null);
});

test('16. sede_id real se conserva', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa', sede_id: 9, created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.event.sede_id, 9);
});

test('17. sede_id no se inventa', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1, texto: 'x', estado: 'activa', created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.event.sede_id, null);
});

test('18. Campos privados y administrativos quedan excluidos', () => {
  const r = tryNormalizeComunidadEvent({
    id: 1,
    texto: 'hola',
    estado: 'activa',
    created_at: '2026-07-01T00:00:00Z',
    motivo_moderacion: 'spam',
    email: 'x@y.com',
    imagen_url: 'https://x/y.png',
  });
  assert.equal(r.ok, true);
  assert.equal(assertNoPrivateLeak(r.event), true);
  const blob = JSON.stringify(r.event);
  assert.equal(blob.includes('motivo_moderacion'), false);
  assert.equal(blob.includes('email'), false);
  assert.equal(blob.includes('imagen_url'), false);
});

test('19-20. Filtro tipos=comunidad y combinado', () => {
  assert.deepEqual(parseHistorialTipos('comunidad'), ['comunidad']);
  assert.deepEqual(
    parseHistorialTipos('reserva,comunidad,asistencia'),
    ['reserva', 'comunidad', 'asistencia'],
  );
});

test('21-23. Filtros fecha y sede', () => {
  const a = tryNormalizeComunidadEvent({
    id: 1, texto: 'a', estado: 'activa', sede_id: 1,
    created_at: '2026-05-01T00:00:00Z',
  }).event;
  const b = tryNormalizeComunidadEvent({
    id: 2, texto: 'b', estado: 'activa', sede_id: 1,
    created_at: '2026-07-01T00:00:00Z',
  }).event;
  const filtered = filterHistorialEvents([a, b], {
    tipos: ['comunidad'],
    fecha_desde: '2026-06-01T00:00:00.000Z',
    fecha_hasta: '2026-08-01T00:00:00.000Z',
    sede_id: 1,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'comunidad:2');
});

test('24-25. Cursor estable y segunda página sin duplicados', () => {
  const events = [1, 2, 3].map((n) => tryNormalizeComunidadEvent({
    id: n, texto: `p${n}`, estado: 'activa',
    created_at: '2026-05-01T12:00:00.000Z',
  }).event);
  const sorted = filterHistorialEvents(events);
  const page1 = paginateHistorialEvents(sorted, 2);
  const page2 = paginateHistorialEvents(
    filterHistorialEvents(sorted, {
      cursor: { occurred_at: page1.items[1].occurred_at, id: page1.items[1].id },
    }),
    2,
  );
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 1);
  assert.equal(new Set([...page1.items, ...page2.items].map((i) => i.id)).size, 3);
});

test('26. Fuente Comunidad vacía no rompe el endpoint', async () => {
  const db = createFase4Mock({ publicaciones: [] });
  const result = await getJugadorHistorial(db, { id: U1 }, { tipos: 'comunidad' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, []);
});

test('27. Error de consulta devuelve respuesta controlada', async () => {
  const db = createFase4Mock({ failTable: 'comunidad_publicaciones' });
  await assert.rejects(
    () => getJugadorHistorial(db, { id: U1 }, { tipos: 'comunidad' }),
    (err) => String(err.message).includes('boom'),
  );
});

test('29. ranking_oficial y ranking_quantum siguen siendo tipos inválidos', () => {
  assert.throws(() => parseHistorialTipos('ranking_oficial'), (e) => e.status === 400);
  assert.throws(() => parseHistorialTipos('ranking_quantum'), (e) => e.status === 400);
  assert.deepEqual(parseHistorialTipos('comunidad,ranking_oficial'), ['comunidad']);
});

test('30. Adapter solo lee Comunidad (sin writes)', async () => {
  const touched = new Set();
  const db = createFase4Mock({
    touched,
    publicaciones: [{
      id: 1, autor_user_id: U1, texto: 'ok', estado: 'activa', visibilidad: 'seguidores',
      created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    }],
    reacciones: [{ publicacion_id: 1 }],
    comentarios: [{ publicacion_id: 1, estado: 'activo' }],
  });
  const { events } = await fetchComunidadHistorialEvents(db, { id: U1 }, { sourceLimit: 20 });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.likes_count, 1);
  assert.equal(events[0].payload.comentarios_count, 1);
  assert.ok(touched.has('comunidad_publicaciones'));
  assert.ok(touched.has('comunidad_reacciones'));
  assert.ok(touched.has('comunidad_comentarios'));
  assert.equal(touched.has('comunidad_denuncias'), false);
  assert.equal(touched.has('comunidad_seguimientos'), false);
});
