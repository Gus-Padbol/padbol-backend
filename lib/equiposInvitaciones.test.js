import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCanInviteSelf,
  buildEquipoDefinitivoDto,
  buildEquipoNotificacionDedupeKey,
  canCaptainInvite,
  canReopenMembership,
  evaluateAcceptCupo,
  evaluateInviteSlot,
  findConflictingAcceptedTeam,
  findIncompatiblePendingMemberships,
  findMembership,
  isMemberExpired,
  isMemberPending,
  isTorneoOpenForTeams,
  mapBuscarJugadorPublico,
  normalizeEmail,
} from './equiposInvitaciones.js';

const CAPTAIN = { id: 'cap-1', email: 'cap@padbol.com' };
const PLAYER = { id: 'pl-1', email: 'jugador@padbol.com' };

describe('equipos invitaciones — reglas', () => {
  it('1. solo capitán puede invitar', () => {
    assert.equal(canCaptainInvite({ capitan_user_id: 'cap-1' }, CAPTAIN), true);
    assert.equal(canCaptainInvite({ capitan_user_id: 'cap-1' }, PLAYER), false);
  });

  it('2. no capitán / 3. auto invitación', () => {
    const err = assertCanInviteSelf({
      captainUserId: CAPTAIN.id,
      inviteeUserId: CAPTAIN.id,
      inviteeEmail: CAPTAIN.email,
      captainEmail: CAPTAIN.email,
    });
    assert.equal(err?.status, 400);
  });

  it('4. invitación duplicada / cupo', () => {
    const members = [
      { id: 1, estado: 'aceptado', email: 'cap@padbol.com' },
      { id: 2, estado: 'pendiente', email: 'a@padbol.com' },
      { id: 3, estado: 'pendiente', email: 'b@padbol.com' },
    ];
    const err = evaluateInviteSlot({ members, maxJugadores: 4, adding: 2 });
    assert.equal(err?.status, 409);

    const existing = { estado: 'pendiente' };
    assert.equal(canReopenMembership(existing), false);
    assert.equal(canReopenMembership({ estado: 'rechazado' }), true);
  });

  it('5-6. aceptación cupo e idempotencia membership', () => {
    const members = [
      { id: 1, estado: 'aceptado' },
      { id: 2, estado: 'aceptado' },
      { id: 3, estado: 'aceptado' },
      { id: 4, estado: 'aceptado' },
      { id: 5, estado: 'pendiente' },
    ];
    const err = evaluateAcceptCupo({ members, maxJugadores: 4, membershipId: 5 });
    assert.equal(err?.status, 409);

    const mine = findMembership(
      [{ estado: 'pendiente', user_id: PLAYER.id, email: PLAYER.email }],
      PLAYER,
    );
    assert.equal(mine.estado, 'pendiente');
  });

  it('9. cupo completo al invitar', () => {
    const members = Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      estado: 'aceptado',
      email: `p${i}@padbol.com`,
    }));
    assert.equal(evaluateInviteSlot({ members, maxJugadores: 4, adding: 1 })?.status, 409);
  });

  it('10. jugador en otro equipo del torneo', () => {
    const conflict = findConflictingAcceptedTeam({
      acceptedInOtherTeams: [
        { equipo_id: 2, torneo_id: 10, estado: 'aceptado', user_id: PLAYER.id, email: PLAYER.email },
      ],
      userId: PLAYER.id,
      email: PLAYER.email,
      torneoId: 10,
      currentEquipoId: 1,
    });
    assert.ok(conflict);
  });

  it('11. torneo cerrado', () => {
    assert.equal(isTorneoOpenForTeams({ estado: 'finalizado' }), false);
    assert.equal(isTorneoOpenForTeams({ estado: 'abierto' }), true);
  });

  it('12. invitación vencida', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(isMemberExpired({ estado: 'pendiente', expires_at: past }), true);
    assert.equal(isMemberPending({ estado: 'pendiente', expires_at: past }), false);
  });

  it('13-14. equipo abierto/cerrado (visibilidad en DTO)', () => {
    const cerrado = buildEquipoDefinitivoDto({
      summary: {
        capitan_user_id: CAPTAIN.id,
        max_jugadores: 4,
        min_jugadores: 2,
        visibilidad: 'cerrado',
        estado: 'formando',
      },
      members: [{ estado: 'aceptado', tipo: 'invitacion' }],
      viewer: PLAYER,
    });
    assert.equal(cerrado.puede_solicitar, false);

    const abierto = buildEquipoDefinitivoDto({
      summary: {
        capitan_user_id: CAPTAIN.id,
        max_jugadores: 4,
        min_jugadores: 2,
        visibilidad: 'abierto',
        estado: 'formando',
      },
      members: [{ estado: 'aceptado', tipo: 'invitacion' }],
      viewer: PLAYER,
    });
    assert.equal(abierto.puede_solicitar, true);
  });

  it('17. equipo definitivo correcto', () => {
    const dto = buildEquipoDefinitivoDto({
      summary: {
        id: 1,
        capitan_user_id: CAPTAIN.id,
        max_jugadores: 4,
        min_jugadores: 2,
        visibilidad: 'abierto',
        estado: 'formando',
      },
      members: [
        { id: 1, estado: 'aceptado', tipo: 'invitacion', rol: 'capitan' },
        { id: 2, estado: 'aceptado', tipo: 'invitacion' },
        { id: 3, estado: 'pendiente', tipo: 'invitacion' },
        { id: 4, estado: 'pendiente', tipo: 'solicitud' },
      ],
      viewer: CAPTAIN,
    });
    assert.equal(dto.integrantes_confirmados, 2);
    assert.equal(dto.invitaciones_pendientes_count, 1);
    assert.equal(dto.solicitudes_pendientes_count, 1);
    assert.equal(dto.cupos_disponibles, 2);
    assert.equal(dto.equipo_completo, true);
    assert.equal(dto.puede_invitar, true);
  });

  it('18. dedupe key notificaciones', () => {
    const a = buildEquipoNotificacionDedupeKey('invitacion_equipo_recibida', {
      equipoId: 1,
      memberId: 9,
      userId: 'u1',
    });
    const b = buildEquipoNotificacionDedupeKey('invitacion_equipo_recibida', {
      equipoId: 1,
      memberId: 9,
      userId: 'u1',
    });
    assert.equal(a, b);
  });

  it('19. privacidad búsqueda', () => {
    const pub = mapBuscarJugadorPublico({
      user_id: 'u1',
      nombre: 'Ana',
      apellido: 'Pérez',
      apodo: 'anita',
      foto_url: 'https://x/y.jpg',
      email: 'secret@padbol.com',
      nivel: 'Intermedio',
    });
    assert.equal(pub.nombre, 'Ana');
    assert.equal(pub.alias, '@anita');
    assert.equal(pub.email, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(pub, 'email'));
  });

  it('cierra invitaciones incompatibles pendientes', () => {
    const rows = findIncompatiblePendingMemberships({
      allMemberships: [
        {
          id: 10,
          equipo_id: 2,
          torneo_id: 5,
          estado: 'pendiente',
          user_id: PLAYER.id,
          email: PLAYER.email,
        },
      ],
      acceptedUserId: PLAYER.id,
      acceptedEmail: PLAYER.email,
      torneoId: 5,
      currentEquipoId: 1,
    });
    assert.equal(rows.length, 1);
  });

  it('normalize email', () => {
    assert.equal(normalizeEmail('  A@Padbol.com '), 'a@padbol.com');
  });
});
