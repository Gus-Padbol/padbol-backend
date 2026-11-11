import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  finalizarPartidoTorneo,
  partidoHasFinalResult,
  resolveTorneoWinnerSide,
} from './torneos/finalizarPartidoTorneoService.js';

function createFinalizeMock({ partido, onPartidoUpdate, tablesTouched = [] }) {
  const state = {
    partido: partido ? { ...partido } : null,
  };

  const supabase = {
    from(table) {
      tablesTouched.push(table);
      const api = {
        select() { return api; },
        eq() { return api; },
        maybeSingle() {
          if (table === 'partidos') {
            return Promise.resolve({ data: state.partido, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) {
          const filters=[];
          const apply=()=>{
            const key='partido';const row=state[key];
            const equal=(a,b)=>typeof a==='object'&&a!==null?JSON.stringify(a)===b:a===b;
            if(!row||!filters.every(([column,value])=>equal(row[column]??null,value??null)))return {data:null,error:null};
            const id=filters.find(([column])=>column==='id')?.[1];onPartidoUpdate?.(patch,id);
            state[key]={...row,...patch};return {data:{id:row.id},error:null};
          };
          const mutation={eq(column,value){filters.push([column,value]);return mutation;},is(column,value){return mutation.eq(column,value);},select(){return mutation;},maybeSingle:async()=>apply(),then(resolve,reject){return Promise.resolve(apply()).then(resolve,reject);}};
          return mutation;
        },
      };
      return api;
    },
  };

  return { supabase, state, tablesTouched };
}

describe('finalizarPartidoTorneo helpers', () => {
  it('resolveTorneoWinnerSide valida best-of-3', () => {
    assert.equal(resolveTorneoWinnerSide(2, 0), 'A');
    assert.equal(resolveTorneoWinnerSide(1, 2), 'B');
    assert.equal(resolveTorneoWinnerSide(1, 1), null);
  });
});

describe('finalizarPartidoTorneo', () => {
  it('finaliza partido pendiente con resultado válido', async () => {
    const partidoUpdates = [];
    const { supabase, state } = createFinalizeMock({
      partido: {
        id: 45,
        torneo_id: 28,
        estado: 'pendiente',
        resultado: null,
        equipo_a_id: 71,
        equipo_b_id: 72,
        ganador_equipo_id: null,
      },
      onPartidoUpdate: (patch) => partidoUpdates.push(patch),
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 45,
      torneoId: 28,
      resultado: { goles_a: 2, goles_b: 0 },
      context: { fuente: 'manual_admin' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'finalized');
    assert.equal(result.reason, 'finalizado');
    assert.equal(result.updated, true);
    assert.deepEqual(result.resultado, { goles_a: 2, goles_b: 0 });
    assert.equal(result.ganador_equipo_id, 71);
    assert.equal(state.partido.estado, 'finalizado');
    assert.equal(partidoUpdates.length, 1);
    assert.deepEqual(partidoUpdates[0].resultado, { goles_a: 2, goles_b: 0 });
  });

  it('calcula ganador por goles_a/goles_b', async () => {
    const { supabase, state } = createFinalizeMock({
      partido: {
        id: 46,
        torneo_id: 28,
        estado: 'programado',
        resultado: null,
        equipo_a_id: 10,
        equipo_b_id: 20,
      },
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 46,
      resultado: { goles_a: 1, goles_b: 2 },
      context: { fuente: 'scoreboard' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ganador_equipo_id, 20);
    assert.equal(state.partido.ganador_equipo_id, 20);
  });

  it('respeta ganador_equipo_id si viene y coincide', async () => {
    const { supabase, state } = createFinalizeMock({
      partido: {
        id: 47,
        torneo_id: 28,
        estado: 'pendiente',
        resultado: null,
        equipo_a_id: 71,
        equipo_b_id: 72,
      },
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 47,
      resultado: { goles_a: 2, goles_b: 1, ganador_equipo_id: 71 },
      context: { fuente: 'manual_admin', actor_id: 'admin-1' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ganador_equipo_id, 71);
    assert.equal(state.partido.ganador_equipo_id, 71);
  });

  it('rechaza ganador incoherente', async () => {
    const partidoUpdates = [];
    const { supabase, state } = createFinalizeMock({
      partido: {
        id: 48,
        torneo_id: 28,
        estado: 'pendiente',
        resultado: null,
        equipo_a_id: 71,
        equipo_b_id: 72,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 48,
      resultado: { goles_a: 2, goles_b: 0, ganador_equipo_id: 72 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'ganador_incoherente');
    assert.equal(partidoUpdates.length, 0);
    assert.equal(state.partido.estado, 'pendiente');
  });

  it('es idempotente si ya estaba finalizado con mismo resultado', async () => {
    const partidoUpdates = [];
    const { supabase } = createFinalizeMock({
      partido: {
        id: 45,
        torneo_id: 28,
        estado: 'finalizado',
        resultado: { goles_a: 2, goles_b: 0 },
        equipo_a_id: 71,
        equipo_b_id: 72,
        ganador_equipo_id: 71,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 45,
      resultado: { goles_a: 2, goles_b: 0 },
      context: { fuente: 'scoreboard' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'idempotent');
    assert.equal(result.reason, 'ya_finalizado_mismo_resultado');
    assert.equal(result.updated, false);
    assert.equal(partidoUpdates.length, 0);
  });

  it('rechaza overwrite con resultado distinto', async () => {
    const partidoUpdates = [];
    const { supabase, state } = createFinalizeMock({
      partido: {
        id: 45,
        torneo_id: 28,
        estado: 'finalizado',
        resultado: { goles_a: 2, goles_b: 0 },
        equipo_a_id: 71,
        equipo_b_id: 72,
        ganador_equipo_id: 71,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 45,
      resultado: { goles_a: 2, goles_b: 1 },
      context: { allowOverwrite: false },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'partido_ya_finalizado');
    assert.equal(partidoUpdates.length, 0);
    assert.deepEqual(state.partido.resultado, { goles_a: 2, goles_b: 0 });
  });

  it('allowOverwrite true permite reemplazo', async () => {
    const partidoUpdates = [];
    const { supabase, state } = createFinalizeMock({
      partido: {
        id: 45,
        torneo_id: 28,
        estado: 'finalizado',
        resultado: { goles_a: 2, goles_b: 0 },
        equipo_a_id: 71,
        equipo_b_id: 72,
        ganador_equipo_id: 71,
      },
      onPartidoUpdate: (patch) => partidoUpdates.push(patch),
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 45,
      resultado: { goles_a: 1, goles_b: 2 },
      context: { allowOverwrite: true, fuente: 'manual_admin' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'finalized');
    assert.equal(result.reason, 'sobrescrito');
    assert.equal(result.updated, true);
    assert.equal(result.ganador_equipo_id, 72);
    assert.equal(partidoUpdates.length, 1);
    assert.deepEqual(state.partido.resultado, { goles_a: 1, goles_b: 2 });
    assert.equal(state.partido.ganador_equipo_id, 72);
  });

  it('no toca tabla_puntos ni otras tablas', async () => {
    const tablesTouched = [];
    const { supabase } = createFinalizeMock({
      partido: {
        id: 45,
        torneo_id: 28,
        estado: 'pendiente',
        resultado: null,
        equipo_a_id: 71,
        equipo_b_id: 72,
      },
      tablesTouched,
    });

    await finalizarPartidoTorneo(supabase, {
      partidoId: 45,
      resultado: { goles_a: 2, goles_b: 0 },
    });

    assert.ok(tablesTouched.every((table) => table === 'partidos'));
    assert.ok(!tablesTouched.includes('tabla_puntos'));
  });

  it('rechaza resultado inválido sin ganador claro', async () => {
    const partidoUpdates = [];
    const { supabase } = createFinalizeMock({
      partido: {
        id: 45,
        torneo_id: 28,
        estado: 'pendiente',
        resultado: null,
        equipo_a_id: 71,
        equipo_b_id: 72,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await finalizarPartidoTorneo(supabase, {
      partidoId: 45,
      resultado: { goles_a: 1, goles_b: 1 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'resultado_invalido');
    assert.equal(partidoUpdates.length, 0);
  });

  it('partidoHasFinalResult reconoce partido finalizado con goles', () => {
    assert.equal(
      partidoHasFinalResult({
        estado: 'finalizado',
        resultado: { goles_a: 2, goles_b: 0 },
      }),
      true,
    );
    assert.equal(
      partidoHasFinalResult({
        estado: 'pendiente',
        resultado: { goles_a: 2, goles_b: 0 },
      }),
      false,
    );
  });
});


describe('best-of-three result consistency regression',()=>{
  it('rejects fractions and impossible completed set counts',()=>{
    for(const [a,b] of [[3,2],[2.5,1],[2,1.5],[2,-1],[Infinity,0],[NaN,0],[2,2]])assert.equal(resolveTorneoWinnerSide(a,b),null);
    for(const [a,b,winner]of [[2,0,'A'],[2,1,'A'],[0,2,'B'],[1,2,'B']])assert.equal(resolveTorneoWinnerSide(a,b),winner);
  });
  it('invalid Padbol score never writes sporting results',async()=>{
    const {supabase:db}=createFinalizeMock({partido:{id:45,estado:'pendiente',torneo:{deporte:'padbol'},equipo_a_id:71,equipo_b_id:72},onPartidoUpdate(){assert.fail('invalid score must not write');}});
    const response=await finalizarPartidoTorneo(db,{partidoId:45,resultado:{goles_a:3,goles_b:2}});
    assert.equal(response.ok,false);assert.equal(response.reason,'resultado_invalido');
  });
});

it('explicit other sport retains existing score interpretation',async()=>{
 const {supabase,state}=createFinalizeMock({partido:{id:45,torneo_id:28,estado:'pendiente',resultado:null,ganador_equipo_id:null,equipo_a_id:71,equipo_b_id:72,torneo:{deporte:'futbol'}}});
 const r=await finalizarPartidoTorneo(supabase,{partidoId:45,resultado:{goles_a:3,goles_b:2}});assert.equal(r.status,'finalized');assert.equal(state.partido.resultado.goles_a,3);
});
