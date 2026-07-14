import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanchaDeporteWritePatch,
  mapCanchaPublicDto,
  normalizeCanchaDeporteColumnaBody,
  resolveDeporteLabel,
  validateCanchaNombreVisible,
} from './canchaDeporteCustom.js';
import {
  DEPORTE_CUSTOM_PRICING,
  PRICE_SOURCES,
  normalizeSurgeDeporte,
  resolveReservaBasePrice,
} from '../src/pricing/resolveReservaBasePrice.js';

test('1. Crear cancha Padbol: patch solo deporte sin columnas custom', () => {
  const r = buildCanchaDeporteWritePatch({ deporte: 'padbol', nombre: 'Cancha 1' }, { mode: 'create' });
  assert.equal(r.ok, true);
  assert.equal(r.patch.deporte, 'padbol');
  assert.ok(!Object.prototype.hasOwnProperty.call(r.patch, 'deporte_personalizado'));
});

test('2. Crear cancha custom válida', () => {
  const r = buildCanchaDeporteWritePatch({
    deporte: 'custom',
    deporte_personalizado: '  Beach Tennis  ',
    cantidad_jugadores: 4,
    modalidad_custom: 'parejas',
    duracion_sugerida_min: 60,
    observacion_custom: '  Red baja  ',
  }, { mode: 'create' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, {
    deporte: 'custom',
    deporte_personalizado: 'Beach Tennis',
    cantidad_jugadores: 4,
    modalidad_custom: 'parejas',
    duracion_sugerida_min: 60,
    observacion_custom: 'Red baja',
  });
});

test('3. Custom sin nombre → 400', () => {
  const r = buildCanchaDeporteWritePatch({
    deporte: 'custom',
    cantidad_jugadores: 4,
    modalidad_custom: 'individual',
  }, { mode: 'create' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /deporte_personalizado/i);
});

test('4. Custom sin cantidad → 400', () => {
  const r = buildCanchaDeporteWritePatch({
    deporte: 'custom',
    deporte_personalizado: 'X',
    modalidad_custom: 'individual',
  }, { mode: 'create' });
  assert.equal(r.ok, false);
  assert.match(r.error, /cantidad_jugadores/i);
});

test('5. Cantidad 0 o >40 → 400', () => {
  for (const cantidad_jugadores of [0, 41]) {
    const r = buildCanchaDeporteWritePatch({
      deporte: 'custom',
      deporte_personalizado: 'X',
      cantidad_jugadores,
      modalidad_custom: 'equipos',
    }, { mode: 'create' });
    assert.equal(r.ok, false, `cantidad ${cantidad_jugadores}`);
    assert.match(r.error, /cantidad_jugadores/);
  }
});

test('6. Modalidad inválida → 400', () => {
  const r = buildCanchaDeporteWritePatch({
    deporte: 'custom',
    deporte_personalizado: 'X',
    cantidad_jugadores: 2,
    modalidad_custom: 'triples',
  }, { mode: 'create' });
  assert.equal(r.ok, false);
  assert.match(r.error, /modalidad_custom/i);
});

test('7. Duración fuera de rango → 400', () => {
  for (const duracion_sugerida_min of [14, 241]) {
    const r = buildCanchaDeporteWritePatch({
      deporte: 'custom',
      deporte_personalizado: 'X',
      cantidad_jugadores: 2,
      modalidad_custom: 'individual',
      duracion_sugerida_min,
    }, { mode: 'create' });
    assert.equal(r.ok, false, `dur ${duracion_sugerida_min}`);
    assert.match(r.error, /duracion_sugerida_min/);
  }
});

test('8. Editar cancha oficial a custom', () => {
  const r = buildCanchaDeporteWritePatch({
    deporte: 'custom',
    deporte_personalizado: 'Boxeo Fitness',
    cantidad_jugadores: 8,
    modalidad_custom: 'individual',
  }, {
    mode: 'patch',
    existing: { deporte: 'padbol' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.patch.deporte, 'custom');
  assert.equal(r.patch.deporte_personalizado, 'Boxeo Fitness');
});

test('9. Editar custom a oficial limpia metadatos', () => {
  const r = buildCanchaDeporteWritePatch({ deporte: 'padel' }, {
    mode: 'patch',
    existing: {
      deporte: 'custom',
      deporte_personalizado: 'Old',
      cantidad_jugadores: 4,
      modalidad_custom: 'parejas',
      duracion_sugerida_min: 90,
      observacion_custom: 'x',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.patch.deporte, 'padel');
  assert.equal(r.patch.deporte_personalizado, null);
  assert.equal(r.patch.cantidad_jugadores, null);
  assert.equal(r.patch.modalidad_custom, null);
  assert.equal(r.patch.duracion_sugerida_min, null);
  assert.equal(r.patch.observacion_custom, null);
});

test('10. GET DTO deporte_label correcto', () => {
  const official = mapCanchaPublicDto({
    id: 1, sede_id: 1, nombre: 'C1', estado: 'activa', deporte: 'padbol',
  });
  assert.equal(official.deporte_label, 'Padbol');
  assert.equal(official.es_deporte_personalizado, false);

  const custom = mapCanchaPublicDto({
    id: 2,
    sede_id: 1,
    nombre: 'C2',
    estado: 'activa',
    deporte: 'custom',
    deporte_personalizado: 'Beach Tennis',
    cantidad_jugadores: 4,
    modalidad_custom: 'parejas',
  });
  assert.equal(custom.deporte_label, 'Beach Tennis');
  assert.equal(custom.es_deporte_personalizado, true);
  assert.equal(resolveDeporteLabel(custom), 'Beach Tennis');
});

test('11. No remapea custom a Padbol', () => {
  assert.equal(normalizeCanchaDeporteColumnaBody('custom'), 'custom');
  assert.equal(normalizeCanchaDeporteColumnaBody('xyz'), null);
  assert.equal(normalizeSurgeDeporte('custom'), DEPORTE_CUSTOM_PRICING);
  assert.notEqual(normalizeSurgeDeporte('custom'), 'padbol');
});

test('14. Precio custom usa base sede, nunca filas padbol', async () => {
  const sede = {
    id: 1,
    timezone: 'America/Argentina/Buenos_Aires',
    precio_90min: 30000,
  };
  const duraciones = [
    { id: 1, sede_id: 1, duracion_minutos: 90, precio: 28000, activo: true, deporte: null },
    { id: 2, sede_id: 1, duracion_minutos: 90, precio: 99999, activo: true, deporte: 'padbol' },
  ];
  const supabaseAdmin = {
    from(table) {
      const api = {
        _filters: {},
        select() { return api; },
        eq(col, val) { this._filters[col] = val; return api; },
        order() { return api; },
        maybeSingle() {
          if (table === 'sedes') return Promise.resolve({ data: sede, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve, reject) {
          try {
            if (table === 'sedes_duraciones') {
              const rows = duraciones.filter((r) =>
                Number(r.sede_id) === Number(this._filters.sede_id)
                && Number(r.duracion_minutos) === Number(this._filters.duracion_minutos)
                && (this._filters.activo == null || r.activo === this._filters.activo));
              return resolve({ data: rows, error: null });
            }
            return resolve({ data: [], error: null });
          } catch (e) {
            return reject(e);
          }
        },
      };
      return api;
    },
  };

  const priced = await resolveReservaBasePrice(supabaseAdmin, {
    sedeId: 1,
    sede,
    deporte: 'custom',
    duracionMinutos: 90,
    skipFranjas: true,
  });
  assert.equal(priced.deporte, 'custom');
  assert.equal(priced.precio, 28000);
  assert.equal(priced.source, PRICE_SOURCES.SEDES_DURACIONES_BASE);
  assert.notEqual(priced.precio, 99999);
});

test('15. Torneo whitelist no incluye custom (slot técnico separado)', () => {
  // CRUD canchas acepta custom; torneo set clásico no.
  assert.equal(normalizeCanchaDeporteColumnaBody('custom'), 'custom');
  const torneoLike = new Set(['padbol', 'padel', 'pickleball', 'squash', 'tenis', 'futbol_5', 'futbol_7']);
  assert.equal(torneoLike.has('custom'), false);
});

test('16. Compat canchas históricas sin columnas custom', () => {
  const dto = mapCanchaPublicDto({
    id: 9,
    sede_id: 1,
    nombre: 'Histórica',
    estado: 'activa',
    deporte: 'padel',
    // sin deporte_personalizado / cantidad_jugadores / etc.
  });
  assert.equal(dto.deporte, 'padel');
  assert.equal(dto.deporte_label, 'Pádel');
  assert.equal(dto.deporte_personalizado, null);
  assert.equal(dto.cantidad_jugadores, null);
  assert.equal(dto.es_deporte_personalizado, false);
});

test('nombre cancha: trim y largo', () => {
  assert.equal(validateCanchaNombreVisible('  A  ').ok, true);
  assert.equal(validateCanchaNombreVisible('').ok, false);
  assert.equal(validateCanchaNombreVisible('x'.repeat(121)).ok, false);
});
