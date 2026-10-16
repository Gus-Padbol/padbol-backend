import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTournamentDates,tournamentClosureDate,tournamentLocalDate} from './tournamentDates.js';
import {buildCrearTorneoPayload} from './crearTorneoPayload.js';
test('create rejects reversed range and invalid calendar date',()=>{
 for(const dates of [{fecha_inicio:'2026-11-22',fecha_fin:'2026-10-14'},{fecha_inicio:'2026-02-31'}]) assert.throws(()=>buildCrearTorneoPayload({...dates,deporte:'padbol',sede_id:7},'qa'),e=>e.code==='TOURNAMENT_DATES_INVALID');
 assert.deepEqual(validateTournamentDates({fecha_inicio:'2026-11-22',fecha_fin:'2026-11-22'}),{start:'2026-11-22',end:'2026-11-22'});
});
test('real early closure rejects; explicit QA simulation preserves planned date',()=>{
 const event={fecha_inicio:'2026-11-20',fecha_fin:'2026-11-22'};
 assert.throws(()=>tournamentClosureDate(event,'2026-10-15'),e=>e.status===409);
 assert.equal(tournamentClosureDate({...event,es_prueba:true},'2026-10-15'),'2026-11-22');
 assert.equal(tournamentClosureDate(event,'2026-11-22'),'2026-11-22');
});
test('Naples midnight uses event date even before midnight UTC',()=>{
 const event={fecha_inicio:'2026-11-20',fecha_fin:'2026-11-22',plan_nations:{config:{timezone:'Europe/Rome'}}};
 assert.equal(tournamentLocalDate(event,'2026-11-19T23:30:00Z'),'2026-11-20');
 assert.equal(tournamentClosureDate(event,tournamentLocalDate(event,'2026-11-19T23:30:00Z')),'2026-11-20');
});
