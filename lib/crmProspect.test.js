import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreProspect, isPadelOnly} from './crmProspectScoring.js';
import {dedupeKeyFor, normalizeDomain, searchOpenStreetMap} from './crmProspectSource.js';
import {campaignSteps, classifyProspectResponse, renderCampaignMessage} from './crmProspectCampaigns.js';

test('excluye clubes exclusivamente de pádel sin usar afinidad padel como positivo', () => {
  const padel=scoreProspect({name:'Padel Center',sector:'padel',activities:'padel courts'});
  assert.equal(padel.excluded,true); assert.equal(padel.score,0);
  const football=scoreProspect({name:'Fútbol Indoor',sector:'soccer',activities:'soccer futsal indoor',website:'https://club.example',email:'a@club.example',locations_count:2});
  assert.equal(football.excluded,false); assert.ok(football.score>0); assert.equal(football.grade,football.score>=85?'A':football.score>=65?'B':'C');
});

test('la puntuación es explicable y separa evidencia de inferencia', () => {
  const result=scoreProspect({name:'Sports Group',sector:'soccer',activities:'soccer multisport',website:'https://x.example',phone:'+1 305 555 0100'});
  assert.ok(Array.isArray(result.breakdown)); assert.ok(result.breakdown.length>=8); assert.ok(result.breakdown.some(x=>x.inferred)); assert.ok(result.confidence>=0&&result.confidence<=100);
});

test('dedupe usa dominio, email, teléfono o nombre normalizado sin fusionar sólo por nombre', () => {
  assert.equal(normalizeDomain('https://www.ClubExample.com/path'),'clubexample.com');
  assert.equal(dedupeKeyFor({domain:'https://www.ClubExample.com'}),'domain:clubexample.com');
  assert.equal(dedupeKeyFor({email:'A@B.com'}),'email:a@b.com');
  assert.match(dedupeKeyFor({name:'Club Norte',city:'Miami',country:'US'}),/^name:club norte\|us\|miami$/);
});

test('campaña día 0/7/14, variables y clasificación conservadora', () => {
  const steps=campaignSteps({opportunityType:'venue_sale',language:'en'});
  assert.deepEqual(steps.map(s=>s.day),[0,7,14]);
  const msg=renderCampaignMessage(steps[0],{name:'Miami Indoor',city:'Miami',country:'US'},'en');
  assert.equal(msg.subject,'A new sports and business opportunity for your club');
  assert.match(msg.body,/Miami Indoor/);
  assert.match(msg.body,/official equipment/);
  assert.ok(msg.missingExperienceUrl);
  assert.equal(classifyProspectResponse('unsubscribe me'),'opt_out');
  assert.equal(classifyProspectResponse('Please send pricing'),'information_request');
  assert.equal(classifyProspectResponse('Maybe later'),'ambiguous');
  assert.equal(classifyProspectResponse('Out of office'),'automatic_reply');
});

test('la fuente pública se normaliza y respeta el límite de 50', async()=>{
  const fake={ok:true,json:async()=>({elements:Array.from({length:70},(_,i)=>({type:'node',id:i+1,lat:25.7+i/1000,lon:-80.2,tags:{name:`Soccer Center ${i}`,sport:'soccer',website:`https://soccer${i}.example`}}))})};
  const result=await searchOpenStreetMap({country:'US',city:'Miami',limit:50,fetchImpl:async()=>fake});
  assert.equal(result.prospects.length,50); assert.match(result.attribution,/OpenStreetMap/); assert.equal(result.cost_cents,0);
});
