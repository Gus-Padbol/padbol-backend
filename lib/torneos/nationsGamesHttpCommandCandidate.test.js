import test from 'node:test';import assert from 'node:assert/strict';import {commitGamesHttpCommand as commit} from './nationsGamesHttpCommandCandidate.js';
const base={epoch:0,scoreboardId:'m',actorId:'verified-referee',requestId:'10000000-0000-4000-8000-000000000001',kind:'point',team:'A',expectedVersion:'2026-01-01',next:{score_a:15},history:{equipo:'A'}};
test('refetched score and version do not change the command identity',async()=>{
 const commands=[];const pool={query:async(sql,p)=>{commands.push(p[2]);return {rows:[{result:{score_a:15}}]};}};
 await commit({...base,pool});await commit({...base,pool,expectedVersion:'2026-01-02',next:{score_a:30}});assert.equal(commands[0],commands[1]);assert.equal(JSON.parse(commands[0]).actorId,'verified-referee');
});
test('reject malformed request, missing auth, bad team and fallback undo before query',async()=>{
 let queried=0;const pool={query:()=>{queried++;}};
 for(const change of [{requestId:null},{actorId:null},{team:'C'},{history:{equipo:'B'}},{kind:'undo',historyId:null}])await assert.rejects(commit({...base,pool,...change}));assert.equal(queried,0);
});
test('version conflict is explicit 409, never successful result',async()=>{await assert.rejects(commit({...base,pool:{query:async()=>({rows:[{result:null}]})}}),{code:'GAME_VERSION_CONFLICT',status:409});});
