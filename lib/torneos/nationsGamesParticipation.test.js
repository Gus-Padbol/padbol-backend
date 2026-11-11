import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGamesParticipation as calc, canSubstituteAtGameBoundary as gate } from './nationsGamesParticipation.js';
const roster=['a','b','c','d'];
const match=(id,n,pair=['a','b'])=>({id,status:'completed',games:Array.from({length:n},(_,i)=>({id:`g${i+1}`,set:1,number:i+1,completed:true,players:pair}))});
test('four equal matches, each pair plays two: 50% and full points; sum games is 200%',()=>{
 const r=calc({roster,matches:[match('1',12),match('2',12),match('3',12,['c','d']),match('4',12,['c','d'])]});
 assert.equal(r.totalGames,48);for(const p of r.players){assert.equal(p.gamesPlayed,24);assert.equal(p.percentage,50);assert.equal(p.pointsFactor,1);}
 assert.equal(r.players.reduce((s,p)=>s+p.gamesPlayed,0),96);
});
test('unequal two/three set lengths weight games, not number of matches',()=>{
 const a=match('1',12); a.games=a.games.map((g,i)=>({...g,set:Math.floor(i/6)+1,number:i%6+1}));
 const b=match('2',30,['c','d']);b.games=b.games.map((g,i)=>({...g,set:Math.floor(i/10)+1,number:i%10+1}));
 const r=calc({roster,matches:[a,b]});assert.equal(r.totalGames,42);assert.equal(r.players[0].gamesPlayed,12);assert.equal(r.players[0].pointsFactor,12/21);assert.equal(r.players[2].pointsFactor,1);
});
test('eight-player exception: spectators zero, below 50% proportional, never over full points',()=>{
 const r=calc({roster:[...roster,'e','f','g','h'],matches:[match('1',15),match('2',5,['c','d'])]});
 assert.deepEqual(r.players.map(p=>p.pointsFactor),[1,1,.5,.5,0,0,0,0]);
});
test('two and three player squads and empty tournament',()=>{
 assert.equal(calc({roster:['a','b'],matches:[match('1',12)]}).players[0].percentage,100);
 assert.equal(calc({roster:['a','b','c'],matches:[match('1',12)]}).players[2].pointsFactor,0);
 assert.equal(calc({roster,matches:[]}).status,'unconfirmed');
});
test('walkover creates no fictitious games',()=>{
 assert.equal(calc({roster,matches:[{id:'wo',status:'walkover',games:[]}]}).status,'unconfirmed');
 assert.throws(()=>calc({roster,matches:[{...match('wo',1),status:'walkover'}]}),{code:'WALKOVER_HAS_GAMES'});
});
test('incomplete matches, ledger gaps, missing games, duplicate match rejected',()=>{
 for(const m of [{...match('1',1),status:'open'},{id:'1',status:'completed'}, {...match('1',1),games:[]}]) assert.throws(()=>calc({roster,matches:[m]}));
 assert.throws(()=>calc({roster,matches:[match('1',1),match('1',1)]}));
 const m=match('1',3);m.games.splice(1,1);assert.throws(()=>calc({roster,matches:[m]}),{code:'GAME_LEDGER_GAP'});
});
test('unknown players, duplicate player, duplicated game, unconfirmed game rejected',()=>{
 for(const pair of [['a','x'],['a','a'],['a']]) assert.throws(()=>calc({roster,matches:[match('1',1,pair)]}));
 const m=match('1',2);m.games[1].id=m.games[0].id;assert.throws(()=>calc({roster,matches:[m]}));
 m.games[1].id='second';m.games[1].completed=false;assert.throws(()=>calc({roster,matches:[m]}));
});
test('change permitted only after odd completed game, no mid-point or closed/paused match',()=>{
 const base={completedGamesInSet:1,pointInProgress:false,matchStatus:'open',boundaryPolicy:'after_odd_game'};assert.equal(gate(base),true);
 for(const n of [0,2,4,-1,1.5])assert.equal(gate({...base,completedGamesInSet:n}),false);
 for(const state of ['closed','paused'])assert.equal(gate({...base,matchStatus:state}),false);
 assert.equal(gate({...base,pointInProgress:true}),false);assert.equal(gate({...base,pointInProgress:undefined}),false);
});

test('odd-game interpretation has no default until competition policy confirmed',()=>{
 const base={completedGamesInSet:1,pointInProgress:false,matchStatus:'open'}; assert.equal(gate(base),false);
 assert.equal(gate({...base,boundaryPolicy:'after_odd_game'}),true);
 assert.equal(gate({...base,boundaryPolicy:'before_odd_game'}),false);
 assert.equal(gate({...base,completedGamesInSet:2,boundaryPolicy:'before_odd_game'}),true);
});
