import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildNextGenerationOverview, buildNextGenerationOverviewFromCrm,
  canOperateRegistration, normalizeRegistrationPayload, normalizeSessionPayload,
  normalizeVenueApplicationPayload, validateSessionPayload,
} from './nextGenerationAdmin.js';

test('consolida fuente canónica, estados y trazabilidad sin duplicados', () => {
  const overview = buildNextGenerationOverview({
    venues: [{ id: 'v1', sede_club: 'Sede QA' }],
    sessions: [{ id: 's1', sede_id: 'v1', nombre_publico: 'Jornada QA' }],
    registrations: [
      { id: 'r1', sesion_id: 's1', estado: 'confirmada', created_at: '2026-10-01' },
      { id: 'r1', sesion_id: 's1', estado: 'confirmada', created_at: '2026-10-01' },
      { id: 'r2', sesion_id: 's1', estado: 'en_espera', created_at: '2026-10-02' },
      { id: 'r3', sesion_id: 's1', estado: 'cancelada', created_at: '2026-10-03' },
    ],
    participants: [{ id: 'p1', inscripcion_id: 'r1', nombre: 'Jugador' }],
    events: [
      { id: 1, inscripcion_id: 'r1', tipo: 'creada_confirmada', created_at: '2026-10-01' },
      { id: 1, inscripcion_id: 'r1', tipo: 'creada_confirmada', created_at: '2026-10-01' },
    ],
  });
  assert.deepEqual(overview.summary, { total: 3, borradores: 0, confirmadas: 1, en_espera: 1, canceladas: 1 });
  assert.equal(overview.inscripciones.find((row) => row.id === 'r1').eventos.length, 1);
  assert.equal(overview.inscripciones.find((row) => row.id === 'r1').sede.sede_club, 'Sede QA');
});

test('mantiene borradores formales separados de la lista de espera', () => {
  const overview = buildNextGenerationOverview({
    venues: [{ id: 9, nombre: 'Sede oficial' }],
    sessions: [{ id: 's1', sede_id: 9, nombre_publico: 'Jornada 1' }],
    registrations: [{ id: 'r1', sede_id: 9, sesion_id: 's1', estado: 'borrador' }],
  });
  assert.equal(overview.source, 'operational');
  assert.equal(overview.summary.borradores, 1);
  assert.equal(overview.summary.en_espera, 0);
  assert.equal(overview.jornadas.length, 1);
  assert.equal(overview.inscripciones[0].sede.nombre, 'Sede oficial');
});

test('normaliza payload camelCase y snake_case sin aceptar participantes vacíos', () => {
  assert.deepEqual(normalizeRegistrationPayload({
    conversationId: ' conv-1 ', venueId: '44', sessionId: 'session-1', category: ' U16 ',
    participants: [{ name: ' Ana ' }, { name: ' ' }],
  }), {
    conversationId: 'conv-1', sedeId: 44, sessionId: 'session-1', category: 'U16',
    participants: [{ nombre: 'Ana', categoria: null }],
  });
});

test('superadmin opera globalmente y admin_club queda aislado a su sede', () => {
  assert.equal(canOperateRegistration({ superA: true }, { sede_id: 999 }), true);
  assert.equal(canOperateRegistration({ rol: 'admin_club', sedeId: 12 }, { sede_id: 12 }), true);
  assert.equal(canOperateRegistration({ rol: 'admin_club', sedeId: 12 }, { sede_id: 13 }), false);
  assert.equal(canOperateRegistration({ rol: 'empleado', sedeId: 12 }, { sede_id: 12 }), false);
});

test('la migración hace atómicos cupos, espera y promoción y cierra acceso directo', () => {
  const sql = fs.readFileSync(new URL('../sql/20261005170000_next_generation_operations.sql', import.meta.url), 'utf8');
  assert.match(sql, /for update/);
  assert.match(sql, /NG_SESSION_FULL/);
  assert.match(sql, /ng_promote_waitlist/);
  assert.match(sql, /old_state='confirmada'.*ng_promote_waitlist/s);
  assert.match(sql, /unique index if not exists uq_ng_inscripciones_crm_conversation/);
  assert.match(sql, /revoke all on table public\.ng_inscripciones.*from anon, authenticated/s);
  assert.match(sql, /grant execute.*to service_role/s);
});

test('normaliza y valida jornadas completas', () => {
  const payload = normalizeSessionPayload({
    venueId: '8', name: ' Jornada U16 ', city: ' Córdoba ', country: ' Argentina ', category: ' U16 ',
    startsAt: '2026-11-10T14:00:00Z', endsAt: '2026-11-10T18:00:00Z', capacity: '24', status: 'PROGRAMADA',
  });
  assert.deepEqual(payload, {
    sede_id: 8, nombre_publico: 'Jornada U16', ciudad: 'Córdoba', pais: 'Argentina', categoria: 'U16',
    comienza_at: '2026-11-10T14:00:00Z', termina_at: '2026-11-10T18:00:00Z', cupo: 24, estado: 'programada',
  });
  assert.equal(validateSessionPayload(payload), null);
});

test('rechaza jornadas sin cupo, con estado desconocido o fechas invertidas', () => {
  const valid = normalizeSessionPayload({ sede_id: 2, nombre_publico: 'J1', categoria: 'U14', comienza_at: '2026-11-10T14:00:00Z', cupo: 10 });
  assert.equal(validateSessionPayload({ ...valid, cupo: 0 }), 'NG_SESSION_CAPACITY_INVALID');
  assert.equal(validateSessionPayload({ ...valid, estado: 'inventado' }), 'NG_SESSION_STATUS_INVALID');
  assert.equal(validateSessionPayload({ ...valid, termina_at: '2026-11-10T13:00:00Z' }), 'NG_SESSION_DATES_INVALID');
});

test('patch de jornada conserva sólo campos enviados', () => {
  assert.deepEqual(normalizeSessionPayload({ capacity: 30, status: 'activa' }, { partial: true }), { cupo: 30, estado: 'activa' });
});

test('normaliza una postulación de sede proveniente del CRM', () => {
  assert.deepEqual(normalizeVenueApplicationPayload({ conversationId: ' c1 ', venueName: ' Club Centro ', city: ' Lima ', country: ' Perú ' }), {
    conversationId: 'c1', venueName: 'Club Centro', city: 'Lima', country: 'Perú',
  });
});

test('usa formularios Next Generation del CRM cuando el esquema especializado no existe', () => {
  const overview = buildNextGenerationOverviewFromCrm({
    contacts: [{ id: 'c1', nombre: 'Familia Prueba', email_normalized: 'familia@example.com' }],
    conversations: [
      { id: 'ng1', contact_id: 'c1', origin: 'next_generation', subject: 'Inscripción participante', inbound_body: 'workflow=program_registration', created_at: '2026-10-05' },
      { id: 'other', contact_id: 'c1', origin: 'contacto', subject: 'Consulta general', created_at: '2026-10-04' },
    ],
  });
  assert.equal(overview.source, 'crm');
  assert.deepEqual(overview.summary, { total: 1, confirmadas: 0, en_espera: 1, canceladas: 0 });
  assert.equal(overview.inscripciones[0].contacto_nombre, 'Familia Prueba');
  assert.equal(overview.inscripciones[0].origen_crm, true);
});
