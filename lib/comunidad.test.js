import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCanDeleteComentario,
  assertCanDeletePublicacion,
  assertCanEditPublicacion,
  assertCanFollow,
  assertCanInteractDespiteBlocks,
  buildComunidadNotificacionDedupeKey,
  filterFeedVisibility,
  isModeratorRole,
  mapAutorPublico,
  mapPublicacionDto,
  sanitizePlainText,
  toggleReactionState,
} from './comunidadDomain.js';

const AUTHOR = { id: 'u-author' };
const OTHER = { id: 'u-other' };
const MOD = { id: 'u-mod' };

describe('comunidad dominio', () => {
  it('1. sanitize plain text (sin HTML)', () => {
    const t = sanitizePlainText('Hola <script>alert(1)</script> mundo');
    assert.equal(t.includes('<'), false);
    assert.equal(t.includes('script'), false);
    assert.match(t, /Hola/);
    assert.match(t, /mundo/);
  });

  it('2-3. editar propia ok / ajena rechazada', () => {
    const pub = { autor_user_id: AUTHOR.id, estado: 'activa' };
    assert.equal(assertCanEditPublicacion(pub, AUTHOR), null);
    assert.equal(assertCanEditPublicacion(pub, OTHER)?.status, 403);
  });

  it('4. eliminar propia o moderador', () => {
    const pub = { autor_user_id: AUTHOR.id, estado: 'activa' };
    assert.equal(assertCanDeletePublicacion(pub, AUTHOR), null);
    assert.equal(assertCanDeletePublicacion(pub, OTHER)?.status, 403);
    assert.equal(assertCanDeletePublicacion(pub, MOD, { isModerator: true }), null);
  });

  it('5. feed filtrado por bloqueo y visibilidad', () => {
    const rows = [
      { id: 1, estado: 'activa', visibilidad: 'publica', autor_user_id: 'a' },
      { id: 2, estado: 'activa', visibilidad: 'seguidores', autor_user_id: 'b' },
      { id: 3, estado: 'activa', visibilidad: 'publica', autor_user_id: 'blocked' },
      { id: 4, estado: 'eliminada', visibilidad: 'publica', autor_user_id: 'a' },
    ];
    const filtered = filterFeedVisibility(rows, {
      viewerId: 'viewer',
      followingIds: new Set(['b']),
      blockedUserIds: new Set(['blocked']),
    });
    assert.deepEqual(filtered.map((r) => r.id), [1, 2]);
  });

  it('6-7. permisos comentario', () => {
    const com = { autor_user_id: AUTHOR.id, estado: 'activo' };
    assert.equal(assertCanDeleteComentario(com, AUTHOR), null);
    assert.equal(assertCanDeleteComentario(com, OTHER)?.status, 403);
    assert.equal(assertCanDeleteComentario(com, MOD, { isModerator: true }), null);
  });

  it('8-9. reacción toggle idempotente conceptually', () => {
    assert.deepEqual(toggleReactionState(null), { action: 'added', reacted: true });
    assert.deepEqual(toggleReactionState({ id: 1 }), { action: 'removed', reacted: false });
  });

  it('10-11. seguir / auto-seguimiento', () => {
    assert.equal(assertCanFollow({ actorId: AUTHOR.id, targetId: OTHER.id }), null);
    assert.equal(assertCanFollow({ actorId: AUTHOR.id, targetId: AUTHOR.id })?.status, 400);
  });

  it('12-13. bloqueo impide interacción', () => {
    const pairs = [{ blocker_user_id: AUTHOR.id, blocked_user_id: OTHER.id }];
    assert.equal(
      assertCanInteractDespiteBlocks({
        actorId: OTHER.id,
        targetAuthorId: AUTHOR.id,
        blockedPairIds: pairs,
      })?.status,
      403,
    );
    assert.equal(
      assertCanInteractDespiteBlocks({
        actorId: AUTHOR.id,
        targetAuthorId: MOD.id,
        blockedPairIds: pairs,
      }),
      null,
    );
  });

  it('14-16. moderador role + denuncia dedupe key', () => {
    assert.equal(isModeratorRole({ rol: 'super_admin' }), true);
    assert.equal(isModeratorRole({ rol: 'admin_club' }), true);
    assert.equal(isModeratorRole({ rol: 'jugador' }), false);
    const a = buildComunidadNotificacionDedupeKey('comunidad_reaccion', {
      publicacionId: 9,
      userId: 'u1',
    });
    const b = buildComunidadNotificacionDedupeKey('comunidad_reaccion', {
      publicacionId: 9,
      userId: 'u1',
    });
    assert.equal(a, b);
  });

  it('18. privacidad autor público', () => {
    const autor = mapAutorPublico({
      user_id: 'u1',
      nombre: 'Ana',
      apellido: 'Pérez',
      apodo: 'anita',
      foto_url: 'https://x/y.jpg',
      email: 'secret@padbol.com',
      telefono: '111',
    });
    assert.equal(autor.display_name, 'Ana Pérez');
    assert.equal(autor.alias, '@anita');
    assert.equal(autor.email, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(autor, 'email'));
    assert.ok(!Object.prototype.hasOwnProperty.call(autor, 'telefono'));

    const dto = mapPublicacionDto(
      {
        id: 1,
        texto: 'hola',
        imagen_url: null,
        sede_id: null,
        evento_ref: null,
        visibilidad: 'publica',
        estado: 'activa',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        autor_user_id: 'u1',
      },
      { autor, reacciones_count: 2, comentarios_count: 1, reacted: true },
    );
    assert.equal(dto.reacciones_count, 2);
    assert.equal(dto.reacted, true);
    assert.ok(!JSON.stringify(dto).includes('secret@'));
  });

  it('19. permisos eliminada no editable', () => {
    assert.equal(
      assertCanEditPublicacion({ autor_user_id: AUTHOR.id, estado: 'eliminada' }, AUTHOR)?.status,
      404,
    );
  });
});
