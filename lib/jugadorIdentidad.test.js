import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import express from 'express';
import {
  buildIdentidadPropiaResponse,
  getIdentidadPropia,
  hashDocumento,
  maskDocumento,
  normalizeDocumento,
  upsertIdentidadPropia,
  validateFechaNacimiento,
} from '../src/jugador/jugadorIdentidadService.js';
import {
  decryptDocumentoFromStorage,
  encryptDocumentoForStorage,
  hasIdentidadEncryptionKey,
} from '../src/jugador/jugadorIdentidadCrypto.js';
import {
  listAceptaciones,
  registrarAceptacion,
} from '../src/jugador/jugadorAceptacionesService.js';
import { mountJugadorIdentidadRoutes } from '../routes/jugadorIdentidad.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function buildIdentidadStore(initial = null) {
  const state = { row: initial ? { ...initial } : null };

  return {
    get row() { return state.row; },
    from(table) {
      if (table !== 'jugadores_identidad') throw new Error(`unexpected table ${table}`);
      return {
        select() { return this; },
        eq(_field, value) {
          this._userId = value;
          return this;
        },
        maybeSingle: async () => ({
          data: state.row && state.row.user_id === this._userId ? { ...state.row } : null,
          error: null,
        }),
        upsert(payload) {
          state.row = { ...(state.row ?? {}), ...payload };
          return {
            select() { return this; },
            single: async () => ({ data: { ...state.row }, error: null }),
          };
        },
      };
    },
  };
}

function buildAceptacionesStore(initial = []) {
  const rows = [...initial];
  let nextId = rows.length + 1;

  return {
    rows,
    from(table) {
      if (table !== 'jugadores_aceptaciones') throw new Error(`unexpected table ${table}`);
      return {
        select() { return this; },
        eq(field, value) {
          this._filters = this._filters ?? {};
          this._filters[field] = value;
          return this;
        },
        is(field, value) {
          this._filters = this._filters ?? {};
          this._filters[`${field}__is`] = value;
          return this;
        },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async function maybeSingle() {
          const match = rows.find((row) => {
            if (this._filters.user_id && row.user_id !== this._filters.user_id) return false;
            if (this._filters.tipo && row.tipo !== this._filters.tipo) return false;
            if (this._filters.version && row.version !== this._filters.version) return false;
            if (Object.prototype.hasOwnProperty.call(this._filters, 'torneo_id__is')) {
              return row.torneo_id == null;
            }
            if (this._filters.torneo_id != null && row.torneo_id !== this._filters.torneo_id) return false;
            return true;
          });
          this._filters = {};
          return { data: match ?? null, error: null };
        },
        then(resolve, reject) {
          const filtered = rows.filter((row) => (
            !this._filters.user_id || row.user_id === this._filters.user_id
          ));
          this._filters = {};
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
        insert(payload) {
          const existing = rows.find((row) => (
            row.user_id === payload.user_id
            && row.tipo === payload.tipo
            && row.version === payload.version
            && (row.torneo_id ?? null) === (payload.torneo_id ?? null)
          ));
          if (existing) {
            return {
              select() { return this; },
              single: async () => ({
                data: null,
                error: { code: '23505', message: 'duplicate jugadores_aceptaciones' },
              }),
            };
          }
          const created = { id: nextId++, ...payload };
          rows.push(created);
          return {
            select() { return this; },
            single: async () => ({ data: created, error: null }),
          };
        },
      };
    },
  };
}

describe('jugadorIdentidadService — normalización y hash', () => {
  it('normalizeDocumento limpia espacios, guiones y mayúsculas', () => {
    assert.deepEqual(
      normalizeDocumento('DNI', 'ar', '12.345.678'),
      { tipo: 'dni', pais: 'AR', numero: '12345678' },
    );
  });

  it('hashDocumento es estable para la misma entrada', () => {
    const a = hashDocumento('pasaporte', 'US', 'ab 123-456');
    const b = hashDocumento('pasaporte', 'US', 'AB123456');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('maskDocumento enmascara y expone últimos 4', () => {
    assert.deepEqual(maskDocumento('12345678'), {
      masked: '****5678',
      last4: '5678',
    });
  });
});

describe('jugadorIdentidadService — validaciones', () => {
  it('fecha de nacimiento futura es inválida', () => {
    assert.throws(
      () => validateFechaNacimiento('2099-01-01'),
      (err) => err.code === 'FECHA_NACIMIENTO_INVALIDA',
    );
  });

  it('tipo_documento inválido en upsert lanza error', async () => {
    const store = buildIdentidadStore();
    await assert.rejects(
      () => upsertIdentidadPropia(store, USER_ID, {
        tipo_documento: 'licencia',
        pais_documento: 'AR',
        numero_documento: '12345678',
      }),
      (err) => err.code === 'TIPO_DOCUMENTO_INVALIDO',
    );
  });

  it('rechaza user_id ajeno en payload', async () => {
    const store = buildIdentidadStore();
    await assert.rejects(
      () => upsertIdentidadPropia(store, USER_ID, { user_id: OTHER_USER, telefono: '+5491112345678' }),
      (err) => err.code === 'USER_ID_NO_PERMITIDO',
    );
  });
});

describe('jugadorIdentidadService — respuesta segura', () => {
  it('buildIdentidadPropiaResponse no expone hash, cifrado ni notas admin', () => {
    const encrypted = encryptDocumentoForStorage('30123456');
    const response = buildIdentidadPropiaResponse({
      user_id: USER_ID,
      fecha_nacimiento: '1990-05-10',
      tipo_documento: 'dni',
      pais_documento: 'AR',
      numero_documento_cifrado: encrypted,
      numero_documento_hash: hashDocumento('dni', 'AR', '30123456'),
      identidad_estado: 'pendiente_revision',
      identidad_notas_admin: 'secreto admin',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(response.numero_documento_last4, '3456');
    assert.ok(response.numero_documento_masked?.includes('3456'));
    assert.equal(response.identidad_estado, 'pendiente_revision');
    assert.equal(response.completitud.documento_completo, true);
    assert.equal(response.completitud.identidad_minima_completa, true);
    assert.equal(Object.prototype.hasOwnProperty.call(response, 'numero_documento_hash'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response, 'numero_documento_cifrado'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response, 'identidad_notas_admin'), false);
  });

  it('getIdentidadPropia devuelve incompleta si no hay fila', async () => {
    const store = buildIdentidadStore(null);
    const result = await getIdentidadPropia(store, USER_ID);
    assert.equal(result.identidad_estado, 'incompleta');
    assert.equal(result.completitud.identidad_minima_completa, false);
  });
});

describe('jugadorIdentidadService — upsert', () => {
  it('upsert con documento completo pasa a pendiente_revision', async () => {
    const store = buildIdentidadStore();
    const result = await upsertIdentidadPropia(store, USER_ID, {
      fecha_nacimiento: '1995-03-15',
      tipo_documento: 'dni',
      pais_documento: 'AR',
      numero_documento: '28.765.432',
      nacionalidad: 'AR',
      genero: 'masculino',
      telefono: '+54 9 11 1234-5678',
    });

    assert.equal(result.identidad_estado, 'pendiente_revision');
    assert.equal(result.tipo_documento, 'dni');
    assert.equal(result.numero_documento_last4, '5432');
    assert.ok(store.row.numero_documento_hash);
    assert.ok(store.row.numero_documento_cifrado);
  });
});

describe('jugadorIdentidadCrypto', () => {
  const originalKey = process.env.IDENTIDAD_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey == null) delete process.env.IDENTIDAD_ENCRYPTION_KEY;
    else process.env.IDENTIDAD_ENCRYPTION_KEY = originalKey;
  });

  it('sin IDENTIDAD_ENCRYPTION_KEY usa pending_encryption', () => {
    delete process.env.IDENTIDAD_ENCRYPTION_KEY;
    const stored = encryptDocumentoForStorage('ABC12345');
    assert.ok(stored.startsWith('pending_encryption:v1:'));
    assert.equal(decryptDocumentoFromStorage(stored), 'ABC12345');
    assert.equal(hasIdentidadEncryptionKey(), false);
  });

  it('con IDENTIDAD_ENCRYPTION_KEY cifra y descifra', () => {
    process.env.IDENTIDAD_ENCRYPTION_KEY = 'a'.repeat(64);
    const stored = encryptDocumentoForStorage('XYZ98765');
    assert.ok(stored.startsWith('enc:v1:'));
    assert.equal(decryptDocumentoFromStorage(stored), 'XYZ98765');
    assert.equal(hasIdentidadEncryptionKey(), true);
  });
});

describe('jugadorAceptacionesService', () => {
  it('registrarAceptacion idempotente en duplicado', async () => {
    const store = buildAceptacionesStore();
    const payload = { tipo: 'terminos_servicio', version: '2026-01' };

    const first = await registrarAceptacion(store, USER_ID, payload, { ip: '127.0.0.1' });
    const second = await registrarAceptacion(store, USER_ID, payload, { ip: '127.0.0.1' });

    assert.equal(first.already_accepted, false);
    assert.equal(second.already_accepted, true);
    assert.equal(second.idempotent, true);
    assert.equal(store.rows.length, 1);
  });

  it('listAceptaciones devuelve filas del usuario', async () => {
    const store = buildAceptacionesStore([
      {
        id: 1,
        user_id: USER_ID,
        tipo: 'privacidad',
        version: '1.0',
        torneo_id: null,
        aceptado_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const list = await listAceptaciones(store, USER_ID);
    assert.equal(list.length, 1);
    assert.equal(list[0].tipo, 'privacidad');
  });

  it('reglamento_torneo exige torneo_id', async () => {
    const store = buildAceptacionesStore();
    await assert.rejects(
      () => registrarAceptacion(store, USER_ID, { tipo: 'reglamento_torneo', version: 'v1' }),
      (err) => err.code === 'TORNEO_ID_REQUERIDO',
    );
  });
});

describe('jugadorIdentidad routes — auth', () => {
  function createTestApp(getAuthenticatedUser) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountJugadorIdentidadRoutes(router, {
      supabaseAdmin: buildIdentidadStore(),
      getAuthenticatedUser,
    });
    app.use('/api/jugador', router);
    return app;
  }

  async function request(app, method, path, body = null) {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const init = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body) init.body = JSON.stringify(body);
      const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
      const json = await res.json();
      return { status: res.status, json };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('GET /identidad requiere JWT', async () => {
    const app = createTestApp(async () => ({
      user: null,
      status: 401,
      error: 'Se requiere Authorization Bearer token',
    }));

    const { status, json } = await request(app, 'GET', '/api/jugador/identidad');
    assert.equal(status, 401);
    assert.match(json.error, /Bearer/i);
  });

  it('POST /aceptaciones con JWT registra aceptación', async () => {
    const aceptStore = buildAceptacionesStore();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountJugadorIdentidadRoutes(router, {
      supabaseAdmin: aceptStore,
      getAuthenticatedUser: async () => ({ user: { id: USER_ID, email: 'test@example.com' } }),
    });
    app.use('/api/jugador', router);

    const { status, json } = await request(app, 'POST', '/api/jugador/aceptaciones', {
      tipo: 'padbol_match',
      version: '2026-07',
    });

    assert.equal(status, 201);
    assert.equal(json.tipo, 'padbol_match');
    assert.equal(json.already_accepted, false);
  });
});
