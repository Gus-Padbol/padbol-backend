import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCrmRepository } from './crmService.js';

test('el guardado del menú rechaza una revisión obsoleta sin reemplazar datos', async () => {
  let row = { id: 'c1', updated_at: '2026-10-21T10:00:01.000Z', qualification_data: { preserved: true } };
  const supabase = { from(table) {
    assert.equal(table, 'crm_conversations');
    const filters = {};
    let payload;
    const query = {
      update(value) { payload = value; return this; },
      eq(field, value) { filters[field] = value; return this; },
      select() { return this; },
      async maybeSingle() {
        if (Object.entries(filters).some(([field, value]) => row[field] !== value)) return { data: null, error: null };
        row = { ...row, ...payload }; return { data: row, error: null };
      },
    };
    return query;
  } };
  const repository = createSupabaseCrmRepository(supabase);
  await assert.rejects(() => repository.updateQualification('c1', { qualification_data: { replaced: true } },
    { expectedUpdatedAt: '2026-10-21T10:00:00.000Z' }), e => e.code === 'CRM_QUALIFICATION_CONFLICT');
  assert.deepEqual(row.qualification_data, { preserved: true });
  await repository.updateQualification('c1', { qualification_data: { preserved: true, menu: true } },
    { expectedUpdatedAt: row.updated_at });
  assert.equal(row.qualification_data.menu, true);
});
