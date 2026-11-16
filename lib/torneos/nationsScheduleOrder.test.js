import test from 'node:test';import assert from 'node:assert/strict';
import {validateReferenceSlots,nextPendingSlot,inheritKoSlot} from './nationsScheduleOrder.js';
const slots=[];
for(let c=1;c<=3;c++)for(let i=1;i<=10;i++)slots.push({slot_key:`GST${(i-1)*3+c}`,phase:'GST',court_label:String(c),order:i,fecha_hora:'2026-11-20T10:30:00+01:00',partido_id:500+(i-1)*3+c});
const ko=[['QF1','1',11],['QF2','2',11],['QF3','1',12],['QF4','2',12],['SF1','1',13],['SF2','2',13],['THIRD','1',14],['FINAL','1',15]].map(([k,c,o])=>({slot_key:k,phase:k.startsWith('QF')?'QF':k.startsWith('SF')?'SF':k==='THIRD'?'THIRD':'FINAL',court_label:c,order:o,fecha_hora:'2026-11-21T16:30:00+01:00',partido_id:null}));
test('30 GST + 8 KO ordered per court; duration optional',()=>{const r=validateReferenceSlots([...slots,...ko],{requireKo:true});assert.equal(r.filter(x=>x.phase==='GST').length,30);assert.equal(r.filter(x=>x.phase!=='GST').length,8);assert.equal(r.find(x=>x.slot_key==='GST1').duration_minutes,null);});
test('next pending uses court order, keeps delayed slot',()=>{const n=nextPendingSlot([...slots,...ko],{courtLabel:'1',completedMatchIds:[501,504]});assert.equal(n.slot_key,'GST7');});
test('no fake KO match; inheritance only real created match',()=>{assert.throws(()=>inheritKoSlot(ko[0],{id:0}),e=>e.code==='KO_MATCH_REQUIRED');const out=inheritKoSlot(ko[0],{id:900,phase:'QF'});assert.equal(out.partido_id,900);assert.equal(out.fecha_hora,ko[0].fecha_hora);});
test('duplicate/missing GST fails closed',()=>{assert.throws(()=>validateReferenceSlots(slots.slice(1)));assert.throws(()=>validateReferenceSlots([...slots,slots[0]]),e=>e.code==='SCHEDULE_SLOT_DUPLICATE');});

test('THIRD/FINAL are the only canonical keys; visible labels cannot replace them',()=>{
 assert.throws(()=>validateReferenceSlots([...slots,{...ko[6],slot_key:'3rd Place'},{...ko[7],slot_key:'Final'}],{requireKo:true}),e=>e.code==='SCHEDULE_SLOT_KEY_INVALID');
});
