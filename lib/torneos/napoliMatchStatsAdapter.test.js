import test from 'node:test';import assert from 'node:assert/strict';
import {validateMatchTracking,buildObservedMatchStats} from './napoliMatchStatsAdapter.js';
const events=[
 {seq:1,ts:'2026-11-20T10:00:00Z',team:'A',games_a:1,games_b:0,sets_a:0,sets_b:0},
 {seq:2,ts:'2026-11-20T10:01:00Z',team:'B',games_a:1,games_b:1,sets_a:0,sets_b:0},
 {seq:3,ts:'2026-11-20T10:02:00Z',team:'A',games_a:1,games_b:1,sets_a:1,sets_b:0,stb:false},
];
const intervals=[{player_id:'a1',team:'A',from_ts:'2026-11-20T10:00:00Z',to_ts:'2026-11-20T10:03:00Z'},{player_id:'b1',team:'B',from_ts:'2026-11-20T10:00:00Z',to_ts:'2026-11-20T10:01:30Z'}];
test('valida eventos/intervalos ordenados',()=>assert.equal(validateMatchTracking({events,intervals,substitutions:[]}).ok,true));
test('puntos observados sólo dentro del intervalo; no inventa goles/errores',()=>{const r=buildObservedMatchStats({events,intervals,substitutions:[]});assert.equal(r.ok,true);assert.equal(r.team_totals.A.points,2);assert.equal(r.team_totals.B.points,1);const a=r.player_observed.find(p=>p.player_id==='a1');const b=r.player_observed.find(p=>p.player_id==='b1');assert.equal(a.points_observed,2);assert.equal(b.points_observed,1);assert.equal('shots' in r,false);});
test('evento sin timestamp/intervalo inválido falla cerrado',()=>{assert.equal(buildObservedMatchStats({events:[{seq:1,ts:'bad',team:'A'}],intervals,substitutions:[]}).ok,false);assert.equal(buildObservedMatchStats({events,intervals:[{player_id:'x',team:'A',from_ts:'2026-11-20T10:02:00Z',to_ts:'2026-11-20T10:01:00Z'}],substitutions:[]}).ok,false);});
