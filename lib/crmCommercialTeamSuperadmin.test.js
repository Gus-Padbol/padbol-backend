import {test} from 'node:test';import assert from 'node:assert/strict';import {createCommercialSuperadminResolver} from './crmCommercialTeamSuperadmin.js';
const user={id:'u1',email:'admin@example.com',email_confirmed_at:'2026-01-01'};
function db(data,error=null){return {from(){return {select(){return {eq(k,v){assert.equal(k,'user_id');assert.equal(v,'u1');return {async maybeSingle(){return {data,error}}}}}}}}}}
test('superadmin requires authenticated identity and matching stored UUID and email',async()=>{
 for(const row of [{user_id:'u2',email:user.email,role:'super_admin'},{user_id:'u1',email:'other@example.com',role:'super_admin'},{user_id:'u1',email:user.email,role:'asesor'},null])assert.equal(await createCommercialSuperadminResolver(db(row))(user),false);
 assert.equal(await createCommercialSuperadminResolver(db({user_id:'u1',email:user.email,role:'super_admin'}))(user),true);
 assert.equal(await createCommercialSuperadminResolver(db(null))({...user,email_confirmed_at:null}),false);
 await assert.rejects(()=>createCommercialSuperadminResolver(db(null,{}))(user),/LOOKUP_FAILED/);
});
