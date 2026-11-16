import test from 'node:test';import assert from 'node:assert/strict';
import {participationFactor,previewAward,applyAwards,awardKey} from './nationsTour500Awards.js';
test('unit must be explicit; zero and half thresholds',()=>{
 assert.throws(()=>participationFactor({unit:'unknown',player:1,team:2}),/UNIT/);
 assert.equal(participationFactor({unit:'time',player:0,team:0}),0);
 assert.equal(participationFactor({unit:'time',player:3,team:6}),1);
 assert.equal(participationFactor({unit:'sets',player:2,team:6}),0.5);
 assert.equal(participationFactor({unit:'sets',player:2,team:5}),0.5);
});
test('ordinary win cannot award 500; final only',()=>{
 assert.equal(previewAward({eventId:57,playerId:'p',position:1,definitive:false,unit:'time',player:4,team:4}).code,'NOT_DEFINITIVE');
 const a=previewAward({eventId:57,playerId:'p',position:1,definitive:true,unit:'time',player:4,team:4,groupWins:3,eliminatedInGroupStage:true});
 assert.equal(a.points,509); assert.equal(a.bonus,9);
});
test('fractions preserved and idempotent key',()=>{
 const a=previewAward({eventId:57,playerId:'p',position:'QF',definitive:true,unit:'sets',player:2,team:5,ageYears:1});
 assert.equal(a.points,22.5); assert.equal(a.key,awardKey(57,'p'));
 const {next,applied}=applyAwards(new Map(),[a,a]); assert.equal(applied.length,1); assert.equal(next.size,1);
 const second=applyAwards(next,[a]); assert.equal(second.applied.length,0);
});
test('bonus only GS eliminated and unknown proration blocks',()=>{
 assert.equal(previewAward({eventId:57,playerId:'q',position:'R16',definitive:true,unit:'time',player:1,team:1,groupWins:2}).code,'BONUS_ONLY_GS_ELIMINATED');
 assert.equal(previewAward({eventId:57,playerId:'q',position:'GS',definitive:true,unit:'time',player:1,team:1,groupWins:1,eliminatedInGroupStage:true,bonusProration:'bad'}).code,'BONUS_PRORATION_UNRESOLVED');
});
