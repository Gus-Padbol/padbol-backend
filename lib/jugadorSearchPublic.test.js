import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEARCH_MAX_LIMIT,
  escapeIlikeTerm,
  mapJugadorBusquedaPublica,
  mapLegacyEquiposBuscar,
  mapLegacyUsuariosBuscar,
  normalizeSearchQuery,
  parseSearchLimit,
  parseSearchPage,
} from './jugadorSearchPublic.js';

describe('jugadorSearchPublic', () => {
  it('1-5. normaliza q / @alias / escape', () => {
    assert.equal(normalizeSearchQuery('  @anita '), 'anita');
    assert.equal(normalizeSearchQuery('Juan Pérez'), 'Juan Pérez');
    assert.equal(escapeIlikeTerm('a%b_c"d'), 'a\\%b\\_c\\"d');
  });

  it('6. menos de 2 caracteres → vacío vía normalize', () => {
    assert.equal(normalizeSearchQuery('a').length, 1);
  });

  it('7. paginación limit max', () => {
    assert.equal(parseSearchLimit(999), SEARCH_MAX_LIMIT);
    assert.equal(parseSearchPage(0), 1);
    assert.equal(parseSearchPage(3), 3);
  });

  it('8-9. excluir propio y bloqueados', () => {
    const row = {
      user_id: 'u2',
      nombre: 'Ana',
      apellido: 'Pérez',
      username: 'anita',
      nivel: 'Intermedio',
    };
    assert.equal(
      mapJugadorBusquedaPublica(row, {
        viewerId: 'u1',
        excludeIds: new Set(['u2']),
      }),
      null,
    );
    assert.equal(
      mapJugadorBusquedaPublica(row, {
        viewerId: 'u1',
        blockedIds: new Set(['u2']),
        excludeIds: new Set(['u2']),
      }),
      null,
    );
  });

  it('11. privacidad — sin email/tel/doc', () => {
    const item = mapJugadorBusquedaPublica({
      user_id: 'u1',
      nombre: 'Ana',
      apellido: 'Pérez',
      username: 'anita',
      email: 'secret@x.com',
      telefono: '123',
      fecha_nacimiento: '2000-01-01',
      foto_url: 'https://x/y.jpg',
      pais: 'AR',
      ciudad: 'CABA',
      nivel: 'Avanzado',
      rango: 'Oro',
      liga: 'A',
      xp: 10,
      sede_id: 1,
      club: 'La Meca',
    }, { viewerId: 'u9' });
    const blob = JSON.stringify(item);
    assert.equal(item.alias, '@anita');
    assert.equal(item.display_name, 'Ana Pérez');
    assert.ok(!blob.includes('secret@'));
    assert.ok(!/"email"/.test(blob));
    assert.ok(!/"telefono"/.test(blob));
    assert.ok(!/"fecha_nacimiento"/.test(blob));
    assert.equal(item.puede_seguir, true);
    assert.equal(item.es_mi_perfil, false);
  });

  it('12-14. contextos equipo/partido/comunidad', () => {
    const row = { user_id: 'u2', nombre: 'Bob', apellido: 'Lee', username: 'bob' };
    const equipo = mapJugadorBusquedaPublica(row, { viewerId: 'u1', contexto: 'equipo' });
    assert.equal(equipo.puede_invitar_equipo, true);
    assert.equal(equipo.puede_seguir, false);

    const partido = mapJugadorBusquedaPublica(row, {
      viewerId: 'u1',
      contexto: 'partido',
      partidoExcluded: new Set(['u2']),
    });
    assert.equal(partido.puede_invitar_partido, false);
    assert.equal(partido.motivo_no_elegible, 'ya_en_partido');

    const comunidad = mapJugadorBusquedaPublica(row, { viewerId: 'u1', contexto: 'comunidad' });
    assert.equal(comunidad.puede_seguir, true);
  });

  it('15. legacy mappers compatibles', () => {
    const item = mapJugadorBusquedaPublica({
      user_id: 'u1',
      nombre: 'Ana',
      apellido: 'Pérez',
      username: 'anita',
      foto_url: null,
      nivel: 'Intermedio',
    });
    const legU = mapLegacyUsuariosBuscar(item);
    assert.equal(legU.user_id, 'u1');
    assert.equal(legU.username, 'anita');
    assert.ok(!('email' in legU));

    const legE = mapLegacyEquiposBuscar(item);
    assert.equal(legE.display_name, 'Ana Pérez');
    assert.equal(legE.alias, '@anita');
  });

  it('16. null row', () => {
    assert.equal(mapJugadorBusquedaPublica(null), null);
  });

  it('19. mi perfil flags', () => {
    const me = mapJugadorBusquedaPublica({
      user_id: 'u1',
      nombre: 'Yo',
      apellido: '',
      username: 'yo',
    }, { viewerId: 'u1' });
    assert.equal(me.es_mi_perfil, true);
    assert.equal(me.puede_invitar_equipo, false);
    assert.equal(me.puede_seguir, false);
  });
});
