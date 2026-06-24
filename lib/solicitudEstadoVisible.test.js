import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMiSolicitudApiFields,
  mapSolicitudPartidoApiItem,
  resolveSolicitudEstadoVisibleCopy,
} from './solicitudesPartidoHorario.js';

const PARTIDO = {
  id: 10,
  fecha: '2026-08-01',
  hora: '18:00',
  duracion_minutos: 90,
  estado: 'abierto',
};

function solicitud(estado, overrides = {}) {
  return {
    id: 'sol-1',
    solicitante_id: 'user-1',
    estado,
    created_at: new Date().toISOString(),
    expires_at: null,
    ...overrides,
  };
}

describe('resolveSolicitudEstadoVisibleCopy', () => {
  it('estado rechazado devuelve estado_label "No se confirmó tu lugar"', () => {
    const copy = resolveSolicitudEstadoVisibleCopy('rechazado');
    assert.equal(copy.estado_label, 'No se confirmó tu lugar');
    assert.match(copy.estado_mensaje, /Te esperamos en otro partido/);
  });

  it('expirado devuelve "Invitación vencida"', () => {
    const copy = resolveSolicitudEstadoVisibleCopy('expirado');
    assert.equal(copy.estado_label, 'Invitación vencida');
  });

  it('conflicto devuelve "Conflicto de horario"', () => {
    const copy = resolveSolicitudEstadoVisibleCopy('conflicto');
    assert.equal(copy.estado_label, 'Conflicto de horario');
  });
});

describe('mapSolicitudPartidoApiItem — textos visibles', () => {
  it('response pública no contiene "rechazado" en campos amigables', () => {
    const item = mapSolicitudPartidoApiItem(
      solicitud('rechazado'),
      PARTIDO,
      { nombre: 'Nico' },
    );

    assert.equal(item.estado, 'rechazado');
    assert.equal(item.estado_label, 'No se confirmó tu lugar');
    assert.equal(item.etiqueta, 'No se confirmó tu lugar');

    const friendly = JSON.stringify({
      estado_label: item.estado_label,
      estado_mensaje: item.estado_mensaje,
      estado_accion_sugerida: item.estado_accion_sugerida,
      etiqueta: item.etiqueta,
    }).toLowerCase();

    assert.doesNotMatch(friendly, /rechazado/);
  });

  it('invitado activo incluye estado_label y estado_mensaje', () => {
    const item = mapSolicitudPartidoApiItem(
      solicitud('invitado'),
      PARTIDO,
      { nombre_saludo: 'Juan Pablo' },
    );

    assert.equal(item.estado_label, 'Invitación pendiente');
    assert.equal(item.estado_mensaje, 'Tenés una invitación para sumarte a este partido.');
    assert.equal(item.estado_accion_sugerida, 'Aceptá o decliná la invitación.');
  });

  it('pendiente incluye textos de solicitud', () => {
    const item = mapSolicitudPartidoApiItem(solicitud('pendiente'), PARTIDO);
    assert.equal(item.estado_label, 'Solicitud pendiente');
    assert.match(item.estado_mensaje, /capitán/);
  });
});

describe('buildMiSolicitudApiFields', () => {
  it('expone estado_label y estado_mensaje para mi solicitud', () => {
    const fields = buildMiSolicitudApiFields(solicitud('rechazado'), PARTIDO);
    assert.equal(fields.estado, 'rechazado');
    assert.equal(fields.estado_label, 'No se confirmó tu lugar');
    assert.ok(fields.estado_mensaje);
  });
});
