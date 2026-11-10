import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upsertIdentidadPropia } from '../src/jugador/jugadorIdentidadService.js';
const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function failingStore(error) {
  return { from(table) {
    assert.equal(table, 'jugadores_identidad');
    return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: null, error: null }; },
      upsert() { return { select() { return this; }, async single() { return { data: null, error }; } }; }
    };
  } };
}
for (const name of ['idx_jugadores_identidad_doc_hash_unique', 'numero_documento_hash']) {
  test(`document conflict ${name} returns actionable 409`, async () => {
    const error = { code: '23505', message: `duplicate key value violates unique constraint "${name}"` };
    await assert.rejects(upsertIdentidadPropia(failingStore(error), userId, { fecha_nacimiento: '1990-05-10' }),
      e => e.status === 409 && e.code === 'DOCUMENTO_DUPLICADO' && e.message === 'El documento ya está registrado en otra cuenta');
  });
}
test('unrelated unique violation is not mislabeled as document conflict', async () => {
  const error = { code: '23505', message: 'duplicate key value violates unique constraint "another_unique"' };
  await assert.rejects(upsertIdentidadPropia(failingStore(error), userId, { fecha_nacimiento: '1990-05-10' }), e => e === error);
});
test('non-unique errors containing document column are preserved', async () => {
  const error = { code: '42703', message: 'numero_documento_hash missing' };
  await assert.rejects(upsertIdentidadPropia(failingStore(error), userId, { fecha_nacimiento: '1990-05-10' }), e => e === error);
});

test('con fila existente: un solo upsert y sin escrituras parciales', async () => {
  let upserts = 0, selects = 0;
  const error = { code: '23505', message: 'duplicate key value violates unique constraint "idx_jugadores_identidad_doc_hash_unique"' };
  const store = { from(table) {
    assert.equal(table, 'jugadores_identidad');
    return { select() { selects += 1; return this; }, eq() { return this; },
      async maybeSingle() { return { data: { user_id: userId }, error: null }; },
      upsert() { upserts += 1; return { select() { return this; }, async single() { return { data: null, error }; } }; }
    };
  } };
  await assert.rejects(upsertIdentidadPropia(store, userId, { fecha_nacimiento: '1990-05-10' }),
    e => e.status === 409 && e.code === 'DOCUMENTO_DUPLICADO');
  assert.equal(upserts, 1);
  assert.equal(selects, 1);
});
