import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTerritoryRequest,territoryRequestSummary} from './crmTerritoryRequest.js';

test('territory contract retains only bounded declared fields with deterministic purpose fingerprint',()=>{
  const value={scope:' COUNTRY ',country:' <b>Italy</b>\n',region:'Lazio',city:'Rome',details:'Plan '+ 'a'.repeat(1500),email:'private@example.test',passport:'private-document',budget:999999,simulation:{secret:true}};
  const request=createTerritoryRequest(value,{now:()=> '2026-11-12T12:00:00Z'});
  assert.deepEqual(Object.keys(request.territoryRequest),['scope','country','region','city','details']);
  assert.equal(request.territoryRequest.country,'Italy');assert.equal(request.territoryRequest.details.length,1000);
  assert.equal(JSON.stringify(request).includes('private'),false);assert.equal(JSON.stringify(request).includes('999999'),false);
  const repeated=createTerritoryRequest({details:value.details,city:'Rome',region:'Lazio',country:'Italy',scope:'country',unknown:'different'}, {now:()=> '2026-11-12T13:00:00Z'});
  assert.equal(request.fingerprint,repeated.fingerprint);assert.notEqual(request.savedAt,repeated.savedAt);
  assert.notEqual(request.fingerprint,createTerritoryRequest({...value,country:'Spain'}).fingerprint);
  assert.match(territoryRequestSummary(request,'en'),/Territory: Rome, Lazio, Italy/);assert.doesNotMatch(territoryRequestSummary(request,'en'),/private|999999|investment|revenue/);
});

test('legacy territory intent without details remains explicit and invents nothing',()=>{
  const absent=createTerritoryRequest();assert.equal(absent.requestPurpose,'territory');assert.equal('territoryRequest' in absent,false);
  assert.equal(absent.fingerprint,createTerritoryRequest({unrecognized:'drop'}).fingerprint);assert.equal(territoryRequestSummary(absent),'');
  for(const value of [[],true,'country',{scope:'planet'},{country:{private:true}},{details:3}]) assert.throws(()=>createTerritoryRequest(value),{code:'INVALID_TERRITORY_REQUEST',status:400});
});
