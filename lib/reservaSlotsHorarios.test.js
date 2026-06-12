import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESERVA_DURACION_SLOT_DEFAULT_MIN,
  generarIniciosMinutosSlotReserva,
  generarIniciosSmartSlots,
  minutosAHoraReserva,
} from './reservaSlotsHorarios.js';

const SEDE = { horario_apertura: '10:00', horario_cierre: '23:00' };
const FECHA = '2026-06-02';

function horaAMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHoras(inicios) {
  return inicios.map((m) => minutosAHoraReserva(m));
}

describe('generarIniciosSmartSlots', () => {
  it('Test 1: sin reservas → mismos slots que el comportamiento actual', () => {
    const legacy = generarIniciosMinutosSlotReserva(SEDE, FECHA, RESERVA_DURACION_SLOT_DEFAULT_MIN);
    const smart = generarIniciosSmartSlots(SEDE, FECHA, RESERVA_DURACION_SLOT_DEFAULT_MIN, [], []);

    assert.deepEqual(smart, legacy);
  });

  it('Test 2: reserva 18:00-19:30 → el siguiente slot es 19:30, no 19:00', () => {
    const reservas = [{ hora_inicio: '18:00', duracion_minutos: 90 }];
    const smart = generarIniciosSmartSlots(SEDE, FECHA, 90, reservas, []);

    assert.ok(!smart.includes(horaAMinutos('19:00')), `no debe incluir 19:00: ${toHoras(smart)}`);
    assert.ok(smart.includes(horaAMinutos('19:30')), `debe incluir 19:30: ${toHoras(smart)}`);
  });

  it('Test 3: reserva 18:00-19:30 + 20:00-21:30 → slots incluyen 19:30 y 21:30', () => {
    const reservas = [
      { hora_inicio: '18:00', duracion_minutos: 90 },
      { hora_inicio: '20:00', duracion_minutos: 90 },
    ];
    const smart = generarIniciosSmartSlots(SEDE, FECHA, 30, reservas, []);

    assert.ok(smart.includes(horaAMinutos('19:30')), `debe incluir 19:30: ${toHoras(smart)}`);
    assert.ok(smart.includes(horaAMinutos('21:30')), `debe incluir 21:30: ${toHoras(smart)}`);
  });

  it('Test 4: pedido de 60 min en ventana libre de 90 min → el slot entra', () => {
    const reservas = [
      { hora_inicio: '18:00', duracion_minutos: 90 },
      { hora_inicio: '21:00', duracion_minutos: 90 },
    ];
    const smart = generarIniciosSmartSlots(SEDE, FECHA, 60, reservas, []);

    assert.ok(smart.includes(horaAMinutos('19:30')), `debe incluir 19:30: ${toHoras(smart)}`);
  });

  it('Test 5: pedido de 120 min en ventana libre de 90 min → no se ofrece slot', () => {
    const reservas = [
      { hora_inicio: '18:00', duracion_minutos: 90 },
      { hora_inicio: '21:00', duracion_minutos: 90 },
    ];
    const smart = generarIniciosSmartSlots(SEDE, FECHA, 120, reservas, []);

    assert.ok(!smart.includes(horaAMinutos('19:30')), `no debe incluir 19:30: ${toHoras(smart)}`);
  });
});
