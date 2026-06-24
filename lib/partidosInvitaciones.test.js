import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PARTIDO_HORARIO_CONFLICTO_CODE,
  buildInvitacionPartidoRow,
  buildPartidoHorarioConflictoBody,
  cancelarSolicitudesPendientesDePartido,
  computeLugaresDisponiblesPartido,
  computeSolicitudExpiresAt,
  countCuposReservadosSolicitudesActivas,
  isSolicitudExpirada,
  isSolicitudPendienteActiva,
  mapSolicitudEstadoVisible,
  mapSolicitudPartidoApiItem,
  partitionSolicitudesPartidoApiItems,
} from './solicitudesPartidoHorario.js';

const FECHA = '2026-08-01';
const PARTIDO = { id: 10, fecha: FECHA, hora: '18:00', duracion_minutos: 90, estado: 'abierto' };

describe('invitaciones partido — persistencia y API', () => {
  it('invitar jugador crea fila persistible con estado invitado y expires_at', () => {
    const createdMs = new Date('2026-07-31T12:00:00.000Z').getTime();
    const row = buildInvitacionPartidoRow({
      partidoId: 10,
      invitadoId: 'user-nico',
      partido: PARTIDO,
      nowMs: createdMs,
    });

    assert.equal(row.partido_id, 10);
    assert.equal(row.solicitante_id, 'user-nico');
    assert.equal(row.estado, 'invitado');
    assert.ok(row.created_at);
    assert.ok(row.expires_at);
  });

  it('GET solicitudes devuelve invitaciones estado invitado con etiqueta', () => {
    const solicitud = {
      id: 'sol-1',
      solicitante_id: 'user-jp',
      estado: 'invitado',
      created_at: new Date().toISOString(),
      expires_at: computeSolicitudExpiresAt(new Date().toISOString(), PARTIDO),
    };
    const item = mapSolicitudPartidoApiItem(solicitud, PARTIDO, {
      nombre_saludo: 'Juan Pablo',
    });

    assert.equal(item.estado, 'invitado');
    assert.equal(item.estado_label, 'Invitación pendiente');
    assert.equal(item.tipo, 'invitacion');
    assert.equal(item.nombre, 'Juan Pablo');
    assert.equal(item.activa, true);

    const partitioned = partitionSolicitudesPartidoApiItems([item]);
    assert.equal(partitioned.invitaciones.length, 1);
    assert.equal(partitioned.invitaciones_activas.length, 1);
  });

  it('invitación activa aparece mientras no venció', () => {
    const solicitud = {
      id: 'sol-2',
      solicitante_id: 'user-nico',
      estado: 'invitado',
      created_at: new Date().toISOString(),
      expires_at: computeSolicitudExpiresAt(new Date().toISOString(), {
        ...PARTIDO,
        fecha: '2030-08-01',
      }),
    };

    assert.equal(isSolicitudPendienteActiva(solicitud, { ...PARTIDO, fecha: '2030-08-01' }), true);
  });

  it('invitación vencida no cuenta como cupo ocupado', () => {
    const solicitud = {
      id: 'sol-3',
      solicitante_id: 'user-nico',
      estado: 'invitado',
      created_at: '2020-01-01T10:00:00.000Z',
      expires_at: '2020-01-01T11:00:00.000Z',
    };

    assert.equal(countCuposReservadosSolicitudesActivas([solicitud], PARTIDO), 0);
    assert.equal(
      computeLugaresDisponiblesPartido({
        maxJugadores: 4,
        jugadoresConfirmados: 1,
        solicitudes: [solicitud],
        partido: PARTIDO,
      }),
      3,
    );
  });

  it('invitación vencida no puede aceptarse (estado visible expirado)', () => {
    const solicitud = {
      id: 'sol-4',
      estado: 'invitado',
      created_at: '2020-01-01T10:00:00.000Z',
      expires_at: '2020-01-01T11:00:00.000Z',
    };

    assert.equal(isSolicitudExpirada(solicitud, PARTIDO), true);
    assert.equal(mapSolicitudEstadoVisible(solicitud, PARTIDO), 'expirado');
    assert.equal(isSolicitudPendienteActiva(solicitud, PARTIDO), false);
  });

  it('cupos reservados reducen lugares_disponibles', () => {
    const activa = {
      id: 'sol-5',
      estado: 'invitado',
      created_at: new Date().toISOString(),
      expires_at: computeSolicitudExpiresAt(new Date().toISOString(), {
        ...PARTIDO,
        fecha: '2030-08-01',
      }),
    };

    const libres = computeLugaresDisponiblesPartido({
      maxJugadores: 4,
      jugadoresConfirmados: 1,
      solicitudes: [activa],
      partido: { ...PARTIDO, fecha: '2030-08-01' },
    });

    assert.equal(libres, 2);
  });

  it('conflicto horario expone código PARTIDO_HORARIO_CONFLICTO', () => {
    assert.equal(
      buildPartidoHorarioConflictoBody().code,
      PARTIDO_HORARIO_CONFLICTO_CODE,
    );
  });

  it('rechazar libera cupo (no cuenta en activas)', () => {
    const rechazada = {
      id: 'sol-6',
      estado: 'rechazado',
      created_at: new Date().toISOString(),
      expires_at: computeSolicitudExpiresAt(new Date().toISOString(), PARTIDO),
    };

    assert.equal(countCuposReservadosSolicitudesActivas([rechazada], PARTIDO), 0);
  });

  it('vencimiento default 4 horas cuando el partido es lejano', () => {
    const createdAt = '2026-07-31T12:00:00.000Z';
    const expiresAt = computeSolicitudExpiresAt(createdAt, {
      ...PARTIDO,
      fecha: '2026-08-10',
      hora: '18:00',
    });
    const expectedMs = new Date(createdAt).getTime() + 4 * 60 * 60 * 1000;
    assert.equal(new Date(expiresAt).getTime(), expectedMs);
  });

  it('cancelar partido cancela invitaciones pendientes', async () => {
    const updates = [];
    const supabaseAdmin = {
      from() {
        return {
          update(payload) {
            updates.push(payload);
            return {
              eq() {
                return {
                  in() {
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      },
    };

    await cancelarSolicitudesPendientesDePartido(supabaseAdmin, 10);
    assert.deepEqual(updates[0], { estado: 'cancelado' });
  });
});
