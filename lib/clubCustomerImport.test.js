import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerCsv, previewCustomerImport, saveCustomerImport } from './clubCustomerImport.js';
const input = { provider: 'playtomic', rows: [['ID','Nombre','Email','Teléfono','Saldo'], ['123','Ana','ANA@example.com','5492216280711','100']], mapping: { externalId: 0, name: 1, email: 2, phone: 3 } };
test('CSV preserves quoted delimiters, escaped quotes, multiline values and BOM', () => {
  assert.deepEqual(parseCustomerCsv('\uFEFFa;b\r\n"Ana; X";"Una ""cita""\nreal"', ';'), [['a','b'], ['Ana; X','Una "cita"\nreal']]);
});
test('malformed or oversized CSV is rejected', () => {
  for (const value of ['a\n"unfinished', 'a\n"quoted"junk', 'a\na"b', 'x'.repeat(2_000_001)]) assert.throws(() => parseCustomerCsv(value));
});
test('preview preserves recipient spelling and excludes wallet and consent fields', () => {
  const p = previewCustomerImport(input);
  assert.equal(p.canConfirm, true); assert.equal(p.customers[0].phone, '5492216280711');
  assert.equal(p.customers[0].email, 'ana@example.com');
  assert.deepEqual(p.ignoredColumns, ['Saldo']);
  assert.equal(p.customers[0].wallet, undefined); assert.equal(p.customers[0].marketingConsent, undefined);
});
test('MATCHi worksheet rows require explicit columns and support accents', () => {
  const p = previewCustomerImport({ provider: 'matchi', rows: [['Kundnummer','Namn'], ['42','José']], mapping: {externalId:0,name:1} });
  assert.equal(p.canConfirm, true); assert.equal(p.customers[0].name,'José');
});
test('duplicate ID or normalized email prevents confirmation', () => {
  for (const row of [['123','Other','other@example.com','',''], ['456','Ana','ana@example.com','','']]) {
    const p = previewCustomerImport({...input, rows: [...input.rows,row]}); assert.equal(p.canConfirm,false); assert.equal(p.errors.length,1); assert.equal(p.duplicates,1);
  }
});
test('invalid mapping cannot reinterpret a balance as an approved target field', () => {
  assert.throws(() => previewCustomerImport({...input,mapping:{...input.mapping,balance:4}}));
  assert.throws(() => previewCustomerImport({...input,mapping:{name:1,email:1}}));
});
test('bad width, missing names and invalid emails block whole file', () => {
  for (const row of [['short'],['1','','a@example.com','',''],['1','Ana','bad','','']]) assert.equal(previewCustomerImport({...input,rows:[input.rows[0],row]}).canConfirm,false);
});
test('changed preview cannot be committed', async () => {
  let touched=false;
  await assert.rejects(saveCustomerImport({pool:{connect(){touched=true;}},venueId:1,actorId:'actor',input,fingerprint:'wrong'}));
  assert.equal(touched,false);
});
test('transaction rolls back if a previously imported record conflicts', async () => {
  const calls=[];
  const db={async query(sql){calls.push(sql); return {rows:sql.startsWith('SELECT source_key')?[{name:'Different',email:'ana@example.com',phone:''}]:[]};},release(){calls.push('RELEASE');}};
  await assert.rejects(saveCustomerImport({pool:{connect:async()=>db},venueId:1,actorId:'actor',input,fingerprint:previewCustomerImport(input).fingerprint}));
  assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT')); assert.equal(calls.at(-1),'RELEASE');
});
