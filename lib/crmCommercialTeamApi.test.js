import {test} from 'node:test';import assert from 'node:assert/strict';import {createCommercialTeamApi} from './crmCommercialTeamApi.js';
test('API derives authority from verified server lookup, never from request fields',async()=>{
 const calls=[],manager='7225442b-defd-42c1-a5a2-b9c1c339fa69',advisor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const db={async rpc(name,args){calls.push({name,args});if(name==='crm_commercial_team_role')return{data:args.p_actor===manager?'manager':'advisor'};if(name==='crm_commercial_team_case_list'||name==='crm_commercial_team_form_list')return{data:[]};if(name==='crm_commercial_case_assign')return{data:{id,assignedAdvisorId:advisor,assignmentVersion:1}};return{data:[]}}};
 const api=createCommercialTeamApi({db,sendClaimed:async()=>({status:'sent'}),resolveTrustedSuperadmin:async()=>false});
 const user={id:advisor,email:'a@example.com',superadmin:true};assert.deepEqual(await api.list(user),{cases:[]});assert.equal(calls[0].args.p_superadmin,false);
 await assert.rejects(api.addAdvisor(user,'any@example.com'),{status:403});
 const result=await api.assign({id:manager,email:'sm@padbol.com'},'whatsapp',id,advisor,0);assert.equal(result.case.version,1);
 await assert.rejects(api.assign({id:manager,email:'sm@padbol.com'},'whatsapp',id,advisor,-1),{status:400});
});

test('progress: gestion no cerrada exige fecha futura (NEXT_CONTACT_REQUIRED) sin escribir', async () => {
  const calls = [];
  const db = {async rpc(name, args) { calls.push({name, args});
    if (name === 'crm_commercial_team_role') return {data: 'manager'};
    if (name === 'crm_commercial_team_calls_list') return {data: [{status: 'completed'}]};
    if (name === 'crm_commercial_team_progress_scheduled' || name === 'crm_commercial_team_progress_outcome') return {data: {case: {version: 2}}};
    return {data: []};}};
  const api = createCommercialTeamApi({db, sendClaimed: async () => ({status: 'sent'}), resolveTrustedSuperadmin: async () => false});
  const user = {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a@example.com'};
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const missing of [undefined, null]) {
    calls.length = 0;
    await assert.rejects(api.progress(user, 'whatsapp', id, 1, 'nuevo', 'Llamar', missing), {status: 400, code: 'NEXT_CONTACT_REQUIRED'});
    assert.equal(calls.some((c) => /progress/.test(c.name)), false, 'no debe escribir sin fecha');
  }
  calls.length = 0;
  await assert.rejects(api.progress(user, 'whatsapp', id, 1, 'nuevo', 'Llamar', ''), {status: 400});
  assert.equal(calls.some((c) => /progress/.test(c.name)), false);
  const future = new Date(Date.now() + 86400000).toISOString();
  await api.progress(user, 'whatsapp', id, 1, 'nuevo', 'Llamar', future);
  const wrote = calls.find((c) => c.name === 'crm_commercial_team_progress_scheduled');
  assert.equal(wrote.args.p_next_contact_at, future);
  // cierre sin fecha sigue permitido y no reescribe la agenda
  calls.length = 0;
  await api.progress(user, 'whatsapp', id, 2, 'cerrado', 'Cerrado', undefined, undefined, 'venta_concretada');
  const closed = calls.find((c) => c.name === 'crm_commercial_team_progress_outcome');
  assert.equal(closed.args.p_next_contact_at, null);
  assert.equal(closed.args.p_update_schedule, true);
});
