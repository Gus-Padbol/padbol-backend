import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  validateFechaNacimiento,
  upsertIdentidadPropia,
} from '../src/jugador/jugadorIdentidadService.js';
import {
  buildIdentidadUpsertPayloadFromPerfilBody,
  buildPerfilFichaIdentidadFields,
  fetchIdentidadForPerfil,
  perfilBodyHasIdentidadFields,
  resolvePaisDocumentoFallback,
  validateCiudad,
} from '../src/jugador/jugadorPerfilFichaService.js';
import { encryptDocumentoForStorage } from '../src/jugador/jugadorIdentidadCrypto.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildPerfilIdentidadStores({ perfil = null, identidad = null } = {}) {
  const perfilRow = perfil ? { ...perfil } : null;
  let identidadRow = identidad ? { ...identidad } : null;

  const identidadStore = {
    get row() { return identidadRow; },
    from(table) {
      if (table !== 'jugadores_identidad') throw new Error(`unexpected ${table}`);
      return {
        select() { return this; },
        eq(_field, value) {
          this._userId = value;
          return this;
        },
        maybeSingle: async function maybeSingle() {
          return {
            data: identidadRow && identidadRow.user_id === this._userId
              ? { ...identidadRow }
              : null,
            error: null,
          };
        },
        upsert(payload) {
          identidadRow = { ...(identidadRow ?? {}), ...payload };
          return {
            select() { return this; },
            single: async () => ({ data: { ...identidadRow }, error: null }),
          };
        },
      };
    },
  };

  const perfilStore = {
    get row() { return perfilRow; },
    from(table) {
      if (table !== 'jugadores_perfil') throw new Error(`unexpected ${table}`);
      return {
        select() { return this; },
        eq(_field, value) {
          this._email = value;
          return this;
        },
        maybeSingle: async function maybeSingle() {
          return {
            data: perfilRow && perfilRow.email === this._email ? { ...perfilRow } : null,
            error: null,
          };
        },
        update(payload) {
          Object.assign(perfilRow, payload);
          return {
            eq() { return this; },
            select() { return this; },
            then(resolve) {
              resolve({ data: [{ ...perfilRow }], error: null });
            },
          };
        },
      };
    },
  };

  return {
    identidadStore,
    perfilStore,
    admin: {
      from(table) {
        if (table === 'jugadores_identidad') return identidadStore.from(table);
        if (table === 'jugadores_perfil') return perfilStore.from(table);
        throw new Error(`unexpected ${table}`);
      },
    },
  };
}

describe('jugadorPerfilFichaService — validación', () => {
  it('validateCiudad acepta null/vacío y rechaza demasiado largo', () => {
    assert.equal(validateCiudad(null), null);
    assert.equal(validateCiudad(''), null);
    assert.equal(validateCiudad(' La Plata '), 'La Plata');
    assert.throws(() => validateCiudad('x'.repeat(121)), /ciudad inválida/);
  });

  it('fecha_nacimiento válida e inválida', () => {
    assert.equal(validateFechaNacimiento('1990-05-10'), '1990-05-10');
    assert.throws(() => validateFechaNacimiento('10/05/1990'), /YYYY-MM-DD/);
    assert.throws(() => validateFechaNacimiento('2099-01-01'), /futura/);
  });

  it('buildIdentidadUpsertPayloadFromPerfilBody respeta actualización parcial', () => {
    assert.deepEqual(
      buildIdentidadUpsertPayloadFromPerfilBody({ nombre: 'Ana', genero: 'masculino' }),
      { genero: 'masculino' },
    );
    assert.equal(perfilBodyHasIdentidadFields({ nombre: 'Ana' }), false);
    assert.equal(perfilBodyHasIdentidadFields({ ciudad: 'Rosario' }), false);
    assert.equal(perfilBodyHasIdentidadFields({ nacionalidad: 'Argentina' }), true);
  });

  it('resolvePaisDocumentoFallback prioriza pais_documento, luego pais', () => {
    assert.equal(resolvePaisDocumentoFallback({ pais_documento: 'AR' }), 'AR');
    assert.equal(resolvePaisDocumentoFallback({ pais: 'Argentina' }), 'Argentina');
    assert.equal(resolvePaisDocumentoFallback({}, 'Uruguay'), 'Uruguay');
  });
});

describe('jugadorPerfilFichaService — GET ficha identidad', () => {
  it('usuario histórico sin fila identidad devuelve nulls', async () => {
    const { admin } = buildPerfilIdentidadStores();
    const fields = await fetchIdentidadForPerfil(admin, USER_ID);
    assert.deepEqual(fields, {
      tipo_documento: null,
      numero_documento: null,
      fecha_nacimiento: null,
      nacionalidad: null,
      genero: null,
    });
  });

  it('GET incluye los seis campos desde jugadores_identidad + ciudad en perfil', async () => {
    const encrypted = encryptDocumentoForStorage('30123456');
    const { admin, perfilStore } = buildPerfilIdentidadStores({
      identidad: {
        user_id: USER_ID,
        fecha_nacimiento: '1992-03-15',
        tipo_documento: 'dni',
        numero_documento_cifrado: encrypted,
        nacionalidad: 'Argentina',
        genero: 'masculino',
      },
      perfil: {
        user_id: USER_ID,
        email: 'test@padbol.com',
        ciudad: 'La Plata',
        pais: 'Argentina',
      },
    });

    const fields = await fetchIdentidadForPerfil(admin, USER_ID);
    assert.equal(fields.tipo_documento, 'dni');
    assert.equal(fields.numero_documento, '30123456');
    assert.equal(fields.fecha_nacimiento, '1992-03-15');
    assert.equal(fields.nacionalidad, 'Argentina');
    assert.equal(fields.genero, 'masculino');
    assert.equal(perfilStore.row.ciudad, 'La Plata');
  });

  it('no expone campos sensibles de identidad', () => {
    const payload = buildPerfilFichaIdentidadFields({
      user_id: USER_ID,
      fecha_nacimiento: '1990-01-01',
      tipo_documento: 'dni',
      numero_documento_cifrado: encryptDocumentoForStorage('12345678'),
      numero_documento_hash: 'abc123hash',
      nacionalidad: 'AR',
      genero: 'otro',
      identidad_notas_admin: 'secreto',
    });

    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'numero_documento_hash'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'numero_documento_cifrado'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'identidad_notas_admin'), false);
    assert.equal(payload.numero_documento, '12345678');
  });
});

describe('jugadorPerfilFichaService — PUT parcial', () => {
  const originalKey = process.env.IDENTIDAD_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.IDENTIDAD_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    if (originalKey == null) delete process.env.IDENTIDAD_ENCRYPTION_KEY;
    else process.env.IDENTIDAD_ENCRYPTION_KEY = originalKey;
  });

  it('PUT modifica un solo campo identidad sin borrar los demás', async () => {
    const encrypted = encryptDocumentoForStorage('30111222');
    const { admin } = buildPerfilIdentidadStores({
      identidad: {
        user_id: USER_ID,
        fecha_nacimiento: '1990-01-01',
        tipo_documento: 'dni',
        pais_documento: 'AR',
        numero_documento_cifrado: encrypted,
        numero_documento_hash: 'existing',
        nacionalidad: 'Argentina',
        genero: 'masculino',
        identidad_estado: 'pendiente_revision',
      },
    });

    await upsertIdentidadPropia(admin, USER_ID, { genero: 'femenino' });
    const after = await fetchIdentidadForPerfil(admin, USER_ID);

    assert.equal(after.genero, 'femenino');
    assert.equal(after.nacionalidad, 'Argentina');
    assert.equal(after.fecha_nacimiento, '1990-01-01');
    assert.equal(after.tipo_documento, 'dni');
    assert.equal(after.numero_documento, '30111222');
  });

  it('PUT modifica varios campos identidad', async () => {
    const { admin } = buildPerfilIdentidadStores({
      identidad: {
        user_id: USER_ID,
        identidad_estado: 'incompleta',
      },
    });

    await upsertIdentidadPropia(admin, USER_ID, {
      fecha_nacimiento: '1988-12-01',
      tipo_documento: 'dni',
      pais_documento: 'AR',
      numero_documento: '28456789',
      nacionalidad: 'Argentina',
      genero: 'prefiero_no_decir',
    });

    const after = await fetchIdentidadForPerfil(admin, USER_ID);
    assert.equal(after.fecha_nacimiento, '1988-12-01');
    assert.equal(after.tipo_documento, 'dni');
    assert.equal(after.numero_documento, '28456789');
    assert.equal(after.nacionalidad, 'Argentina');
    assert.equal(after.genero, 'prefiero_no_decir');
  });

  it('documento vacío explícito rechazado; omitir campo no borra documento', async () => {
    const encrypted = encryptDocumentoForStorage('30999888');
    const { admin } = buildPerfilIdentidadStores({
      identidad: {
        user_id: USER_ID,
        tipo_documento: 'dni',
        pais_documento: 'AR',
        numero_documento_cifrado: encrypted,
        numero_documento_hash: 'hash',
        identidad_estado: 'pendiente_revision',
      },
    });

    await assert.rejects(
      () => upsertIdentidadPropia(admin, USER_ID, { numero_documento: '' }),
      (err) => err.code === 'NUMERO_DOCUMENTO_INVALIDO',
    );

    await upsertIdentidadPropia(admin, USER_ID, { nacionalidad: 'Uruguay' });
    const after = await fetchIdentidadForPerfil(admin, USER_ID);
    assert.equal(after.numero_documento, '30999888');
    assert.equal(after.nacionalidad, 'Uruguay');
  });

  it('tipo_documento inválido rechazado', async () => {
    const { admin } = buildPerfilIdentidadStores();
    await assert.rejects(
      () => upsertIdentidadPropia(admin, USER_ID, { tipo_documento: 'licencia' }),
      (err) => err.code === 'TIPO_DOCUMENTO_INVALIDO',
    );
  });

  it('compatibilidad payload Nativa anterior sin campos identidad', () => {
    const legacyPayload = {
      nombre: 'Juan',
      apellido: 'Pérez',
      telefono: '+5491112345678',
      pais: 'Argentina',
      nivel: 'intermedio',
      lateralidad: 'derecha',
      deportes: ['padbol'],
    };

    assert.equal(perfilBodyHasIdentidadFields(legacyPayload), false);
    assert.deepEqual(buildIdentidadUpsertPayloadFromPerfilBody(legacyPayload), {});
  });
});

describe('jugadorPerfilFichaService — payload parcial identidad', () => {
  it('buildIdentidadUpsertPayloadFromPerfilBody solo incluye claves presentes', () => {
    assert.deepEqual(
      buildIdentidadUpsertPayloadFromPerfilBody({ fecha_nacimiento: '1990-01-01', genero: 'otro' }),
      { fecha_nacimiento: '1990-01-01', genero: 'otro' },
    );
  });
});
