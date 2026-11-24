import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CONTRACT_FILE_MAX_BYTES,
  CONTRACT_PRIVATE_BUCKET,
  contractError,
  contractStoragePath,
  isoDateFromRow,
  normalizePrivateStorageConfig,
  parseContractUUID,
  parseSedeId,
  validateContractFile,
  validateContractMetadata,
} from './sedeContracts.js';

const PDF = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const UUID = '11111111-1111-4111-8111-111111111111';

test('sede id: entero seguro positivo y acotado', () => {
  assert.equal(parseSedeId('501'), 501);
  assert.equal(parseSedeId(' 502 '), 502);
  for (const invalid of ['0', '-1', '1.5', '01', 'abc', '', '99999999999999999', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parseSedeId(invalid), (error) => error.status === 400 && error.code === 'sede_id_invalido');
  }
});

test('contrato UUID: estable, válido y generado sólo si el caller no lo envía', () => {
  assert.equal(parseContractUUID(UUID.toUpperCase()), UUID);
  assert.equal(parseContractUUID(`  ${UUID}  `), UUID);
  assert.throws(() => parseContractUUID('no-es-uuid'), (error) => error.code === 'contrato_uuid_invalido');
  assert.throws(() => parseContractUUID([UUID]), (error) => error.code === 'contrato_uuid_invalido');
  assert.throws(() => parseContractUUID(42), (error) => error.code === 'contrato_uuid_invalido');
  assert.throws(() => parseContractUUID(undefined, { required: true }), (error) => error.code === 'contrato_uuid_requerido');
  const generated = parseContractUUID(undefined);
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(generated, parseContractUUID(undefined));
});

test('metadatos: fechas reales, orden, referencia acotada y UUID inmutable', () => {
  const parsed = validateContractMetadata({
    sedeId: 501,
    raw: {
      fecha_inicio: '2028-02-29',
      fecha_vencimiento: '2029-03-01',
      referencia: '  REF-053 / Sede  ',
      contrato_uuid: UUID,
    },
  });
  assert.deepEqual(parsed, {
    sedeId: 501,
    contratoUUID: UUID,
    fecha_inicio: '2028-02-29',
    fecha_vencimiento: '2029-03-01',
    referencia: 'REF-053 / Sede',
  });
  assert.equal(validateContractMetadata({ raw: { fecha_inicio: '2026-01-01' } }).fecha_vencimiento, null);
  assert.equal(validateContractMetadata({ raw: { fecha_inicio: '2026-01-01', referencia: '   ' } }).referencia, null);

  assert.throws(
    () => validateContractMetadata({ raw: { fecha_inicio: '2026-02-29' } }),
    (error) => error.code === 'fecha_inicio_invalida',
  );
  assert.throws(
    () => validateContractMetadata({ raw: { fecha_inicio: '2026-06-01', fecha_vencimiento: '2026-05-31' } }),
    (error) => error.code === 'fecha_vencimiento_invalida',
  );
  assert.throws(
    () => validateContractMetadata({ raw: { fecha_inicio: '2026-06-01', referencia: 'x'.repeat(241) } }),
    (error) => error.code === 'referencia_invalida',
  );
  assert.throws(
    () => validateContractMetadata({ raw: { fecha_inicio: '2026-06-01', referencia: 'a\u0000b' } }),
    (error) => error.code === 'referencia_invalida',
  );
});

test('archivo: firma real + MIME declarado + tamaño; nombre del cliente no decide el path', () => {
  for (const [buffer, mime, ext] of [
    [PDF, 'application/pdf', 'pdf'],
    [PNG, 'image/png', 'png'],
    [JPEG, 'image/jpeg', 'jpg'],
    [WEBP, 'image/webp', 'webp'],
  ]) {
    const file = validateContractFile({ buffer, mimetype: mime, originalname: `../../${ext}` });
    assert.equal(file.mime, mime);
    assert.equal(file.ext, ext);
    assert.equal(file.size, buffer.length);
    assert.equal(file.sha256, crypto.createHash('sha256').update(buffer).digest('hex'));
    assert.equal(Object.hasOwn(file, 'originalname'), false);
  }

  assert.throws(
    () => validateContractFile({ buffer: PDF, mimetype: 'image/jpeg' }),
    (error) => error.code === 'archivo_mime_invalido',
  );
  assert.throws(
    () => validateContractFile({ buffer: Buffer.from('no es un archivo'), mimetype: 'application/pdf' }),
    (error) => error.code === 'archivo_invalido',
  );
  assert.throws(
    () => validateContractFile({ buffer: Buffer.alloc(0), mimetype: 'application/pdf' }),
    (error) => error.code === 'archivo_invalido',
  );
  const oversize = Buffer.concat([PDF, Buffer.alloc(CONTRACT_FILE_MAX_BYTES)]);
  assert.throws(
    () => validateContractFile({ buffer: oversize, mimetype: 'application/pdf' }),
    (error) => error.status === 413 && error.code === 'archivo_demasiado_grande',
  );
  assert.equal(validateContractFile(null), null);
});

test('path privado determinista por sede+UUID+hash, sin nombre/URL del cliente', () => {
  const sha = crypto.createHash('sha256').update(PDF).digest('hex');
  const first = contractStoragePath({ sedeId: 501, contratoUUID: UUID, sha256: sha, ext: 'pdf' });
  const second = contractStoragePath({ sedeId: 501, contratoUUID: UUID, sha256: sha, ext: 'pdf' });
  assert.equal(first, `501/${UUID}/${sha}.pdf`);
  assert.equal(first, second);
  assert.equal(first.includes('..'), false);
  assert.throws(() => contractStoragePath({ sedeId: 501, contratoUUID: 'x', sha256: sha, ext: 'pdf' }));
  assert.throws(() => contractStoragePath({ sedeId: 501, contratoUUID: UUID, sha256: 'x', ext: 'pdf' }));
  assert.throws(() => contractStoragePath({ sedeId: 501, contratoUUID: UUID, sha256: sha, ext: 'exe' }));
});

test('fechas de PG normalizadas; sólo el bucket/columna privados fijos son aceptados', () => {
  assert.equal(isoDateFromRow('2026-11-24'), '2026-11-24');
  assert.equal(isoDateFromRow(new Date(Date.UTC(2026, 10, 24))), '2026-11-24');
  assert.equal(isoDateFromRow(null), null);

  assert.deepEqual(
    normalizePrivateStorageConfig({ bucket: CONTRACT_PRIVATE_BUCKET, column: 'storage_path' }),
    { bucket: CONTRACT_PRIVATE_BUCKET, column: 'storage_path' },
  );
  assert.equal(normalizePrivateStorageConfig(null), null);
  assert.throws(() => normalizePrivateStorageConfig({ bucket: 'avatars', column: 'storage_path' }));
  assert.throws(() => normalizePrivateStorageConfig({ bucket: 'content-media', column: 'storage_path' }));
  assert.throws(() => normalizePrivateStorageConfig({ bucket: CONTRACT_PRIVATE_BUCKET, column: 'archivo_url' }));
});

test('errores de contrato exponen status/code controlados', () => {
  const error = contractError(409, 'contrato_payload_conflict', 'conflicto');
  assert.equal(error.status, 409);
  assert.equal(error.code, 'contrato_payload_conflict');
  assert.equal(error.message, 'conflicto');
});
