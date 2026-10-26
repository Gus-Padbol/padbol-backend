import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyWelcomeTemplates,welcomeBodies} from './crmWelcomeConfig.js';
const input={enabled:true,chiviReady:true,phoneId:'1376102838911694',wabaId:'928900479733370',version:'v23.0',accessToken:'fixture',templates:{es:{name:'bienvenida_es',locale:'es'},en:{name:'welcome_en',locale:'en'}}};
function fake(modify=()=>{}) {return async url=>{const name=new URL(url).searchParams.get('name');const language=name==='bienvenida_es'?'es':'en';const item={name,language,status:'APPROVED',components:[{type:'BODY',text:welcomeBodies[language]}]};modify(item);return {ok:true,redirected:false,json:async()=>({data:[item]})}}}
test('both exact templates must be approved on the correct account before activation',async()=>{
 assert.equal((await verifyWelcomeTemplates({...input,fetchImpl:fake()})).ready,true);
 for(const change of [{chiviReady:false},{enabled:false},{wabaId:'11111'},{phoneId:'11111'}]) assert.equal((await verifyWelcomeTemplates({...input,...change,fetchImpl:fake()})).ready,false);
 for(const mutate of [x=>x.status='PENDING',x=>x.components[0].text+=' changed',x=>x.components.push({type:'BUTTONS'}),x=>x.language='fr'])assert.equal((await verifyWelcomeTemplates({...input,fetchImpl:fake(mutate)})).ready,false);
});
test('provider failure, redirects and exceptions fail closed without sending',async()=>{
 for(const fetchImpl of [async()=>({ok:false}),async()=>({ok:true,redirected:true}),async()=>{throw Error('network')}]) assert.equal((await verifyWelcomeTemplates({...input,fetchImpl})).ready,false);
});
