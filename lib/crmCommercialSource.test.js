import test from 'node:test';
import assert from 'node:assert/strict';
import {commercialSourceFields,commercialSourceMap} from './crmCommercialSource.js';
import {createCommercialTeamApi} from './crmCommercialTeamApi.js';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const user={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'advisor@example.test'};
test('real origin labels institutional email honestly without treating legacy form-channel DTO as a web form',()=>{
 assert.deepEqual(commercialSourceFields({source_channel:'email',origin:'institutional_email'}),{sourceOrigin:'institutional_email',sourceLabel:'Correo electrónico'});
 assert.equal(commercialSourceFields({source_channel:'email',origin:'web_form:solicitud_licencia'}).sourceLabel,'Formulario web');
 assert.equal(commercialSourceFields({source_channel:'whatsapp',origin:'whatsapp:1376102838911694'}).sourceLabel,'WhatsApp');
 assert.equal(commercialSourceFields().sourceLabel,'Consulta comercial');
});
function fixture({revoked=false,denied=false}={}){
 const calls=[];let formReads=0;
 const db={async rpc(name,args){calls.push({name,args});if(name==='crm_commercial_team_role')return{data:'advisor'};
  if(name==='crm_commercial_team_form_read'){formReads++;return{data:denied||(revoked&&formReads>1)?null:{id,channel:'form',body:'Mensaje original'}};}
  if(name==='crm_commercial_team_schedule_read')return{data:{}};
  if(name==='crm_commercial_team_form_list')return{data:[{id,channel:'form'}]};
  if(name==='crm_commercial_team_case_list'||name==='crm_commercial_team_schedule_list')return{data:[]};
  throw Error('unexpected rpc');},
  from(table){assert.equal(table,'crm_conversations');const builder={select(fields){calls.push({fields});return builder;},in(key,values){calls.push({key,values});return Promise.resolve({data:[{id,source_channel:'email',origin:'institutional_email'},{id:other,source_channel:'email',origin:'web_form:unscoped'}],error:null});},eq(key,value){calls.push({key,value});return builder;},async maybeSingle(){return{data:{id,source_channel:'email',origin:'institutional_email'}};}};return builder;}};
 return {calls,db,api:createCommercialTeamApi({db,sendClaimed:async()=>{},resolveTrustedSuperadmin:async()=>false})};
}
test('commercial detail reads source only after assigned-case authorization and rechecks before returning',async()=>{
 const f=fixture();const value=await f.api.read(user,'form',id);assert.equal(value.sourceLabel,'Correo electrónico');assert.equal(value.body,'Mensaje original');
 const sourceIndex=f.calls.findIndex(c=>c.fields);assert.ok(sourceIndex>f.calls.findIndex(c=>c.name==='crm_commercial_team_form_read'));
 assert.equal(f.calls.filter(c=>c.name==='crm_commercial_team_form_read').length,2);
 const denied=fixture({denied:true});await assert.rejects(denied.api.read(user,'form',id),e=>e.status===404);assert.equal(denied.calls.some(c=>c.fields),false);
 const revoked=fixture({revoked:true});await assert.rejects(revoked.api.read(user,'form',id),e=>e.status===404);
});
test('commercial list loads only authorized IDs and conversation resolver retains actual source',async()=>{
 const f=fixture(),list=await f.api.list(user);assert.equal(list.cases[0].sourceOrigin,'institutional_email');assert.equal(list.cases[0].sourceLabel,'Correo electrónico');
 assert.deepEqual(f.calls.find(c=>c.values).values,[id]);
 const resolved=await f.api.resolveConversation(user,id);assert.equal(resolved.sourceLabel,'Correo electrónico');assert.equal(resolved.channel,'form');
 assert.ok(f.calls.some(c=>c.fields==='id,source_channel,origin'));
});
test('missing source does not invent a web form or enlarge the requested metadata scope',async()=>{
 const data=await commercialSourceMap({from(){throw Error('unavailable')}},[id]);assert.equal(data.size,0);
 let reads=0;assert.equal((await commercialSourceMap({from(){reads++;}},['not-an-id'])).size,0);assert.equal(reads,0);
});
test('metadata lookup canonicalizes UUID casing without dropping verified provenance',async()=>{
 const upper='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',lower=upper.toLowerCase();
 const db={from(){return{select(){return this;},async in(_key,ids){assert.deepEqual(ids,[lower]);return{data:[{id:lower,source_channel:'email',origin:'institutional_email'}]};}};}};
 assert.equal((await commercialSourceMap(db,[upper])).get(lower).sourceLabel,'Correo electrónico');
});
