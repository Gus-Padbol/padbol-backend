import test from 'node:test';import assert from 'node:assert/strict';
import {withGamesLedgerRead,withGamesParticipation} from './nationsGamesReadCandidate.js';
test('single read preserves existing validator and returns same revision ledger',async()=>{
 let count=0,validated=false;const ledger={version:1,total:0,active:[],events:[]};
 class Base{constructor(){this.pool={query:async(sql,args)=>{count++;assert.match(sql,/states, receipts, games_ledger/);assert.deepEqual(args,['id']);return {rows:[{revision:'7',states:{},receipts:{},games_ledger:ledger}]};}};}validateMatch(id,a){validated=true;assert.equal(id,'id');assert.equal(a.revision,7);}}
 const a=await new (withGamesLedgerRead(Base))().getMatch('id');assert.equal(count,1);assert.equal(validated,true);assert.deepEqual(a.gamesLedger,ledger);
});
test('DTO keeps clock participation untouched and adds independent games',()=>{
 const state={status:'open',lineup:{iniciales:['a','b'],suplentes:[]}};
 const body={participation:{seconds:54},matchRevision:7};
 const out=withGamesParticipation(body,{states:{A:state},gamesLedger:{version:1,total:1,active:['g'],events:[{type:'game',historyId:'g',ordinal:1,teams:{A:['a','b']}}]}},'A');
 assert.equal(out.participation,body.participation);assert.equal(out.gamesParticipation.players[0].percentage,100);assert.equal(body.gamesParticipation,undefined);
});
test('schema failure propagates, never substitutes guessed participation',async()=>{
 class Base{constructor(){this.pool={query:async()=>{throw new Error('missing column');}};}}
 await assert.rejects(new (withGamesLedgerRead(Base))().getMatch('id'),/missing column/);
});
