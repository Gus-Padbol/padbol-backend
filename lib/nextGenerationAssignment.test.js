import test from 'node:test';
import assert from 'node:assert/strict';
import {assignNextGenerationRegistration} from './nextGenerationAssignment.js';
import {registerNextGenerationAdminRoutes} from './nextGenerationAdmin.js';
const id='11111111-1111-4111-8111-111111111111';
const session='22222222-2222-4222-8222-222222222222';
const input={registrationId:id,sedeId:1,sessionId:session,category:'U14',scope:{superA:true}};
test('missing pool fails closed without sequential Supabase writes',async()=>{
 const handlers=new Map();let writes=0;
 const app=Object.fromEntries(['get','post','patch'].map(method=>[method,(path,handler)=>handlers.set(method+' '+path,handler)]));
 const supabaseAdmin={from(){return{select(){return this},eq(){return this},maybeSingle:async()=>({data:{id,sede_id:1,sesion_id:session,categoria:'U14',estado:'confirmada'}}),update(){writes++;throw Error('unexpected write')},insert(){writes++;throw Error('unexpected write')}}}};
 registerNextGenerationAdminRoutes(app,{supabaseAdmin,adminListScopeFromRequest:async()=>({superA:true})});
 const res={code:200,status(n){this.code=n;return this},json(body){this.body=body;return this}};
 await handlers.get('patch /api/admin/next-generation/registrations/:id/assignment')({params:{id},body:{sesion_id:session}},res);
 assert.equal(res.code,503);assert.equal(res.body.code,'NG_ASSIGNMENT_UNAVAILABLE');assert.equal(writes,0);
});
test('connection errors do not expose connection details',async()=>{
 await assert.rejects(()=>assignNextGenerationRegistration({connect:async()=>{throw Error('private connection detail')}},input),e=>e.status===503&&e.message==='NG_ASSIGNMENT_UNAVAILABLE');
});
test('row ownership is checked under transaction lock, not from stale route lookup',async()=>{
 const calls=[];let released=false;
 const pool={async connect(){return{async query(sql){calls.push(sql);if(sql.startsWith('SELECT\n'))return{rows:[{isolation:'read committed',read_only:'off',conditions_ok:true}]};if(sql.startsWith('SELECT $1::uuid'))return{rows:[{registration_id:id,session_id:session}]};if(sql.startsWith('SELECT * FROM public.ng_inscripciones'))return{rows:[{id,sede_id:2,estado:'borrador'}]};return{rows:[]}},release(){released=true}}}};
 await assert.rejects(()=>assignNextGenerationRegistration(pool,{...input,scope:{rol:'admin_club',sedeId:1}}),e=>e.status===403);
 assert.ok(calls.includes('ROLLBACK'));assert.equal(calls.some(s=>s.startsWith('UPDATE')),false);assert.equal(released,true);
});
test('uncertain commit is explicit; failed rollback discards connection',async()=>{
 let discarded;
 const pool={async connect(){return{async query(sql){if(sql.startsWith('SELECT\n'))return{rows:[{isolation:'read committed',read_only:'off',conditions_ok:true}]};if(sql.startsWith('SELECT $1::uuid'))return{rows:[{registration_id:id,session_id:session}]};if(sql.startsWith('SELECT * FROM public.ng_inscripciones'))return{rows:[{id,sede_id:1,sesion_id:id,categoria:'U14',estado:'borrador'}]};if(sql.startsWith('SELECT * FROM public.ng_sesiones'))return{rows:[{id:session,sede_id:1,categoria:'U14',estado:'programada'}]};if(sql.startsWith('UPDATE public.ng_inscripciones'))return{rows:[{id}]};if(sql==='COMMIT'||sql==='ROLLBACK')throw Error('transport unknown');return{rows:[]}},release(discard){discarded=discard}}}};
 await assert.rejects(()=>assignNextGenerationRegistration(pool,input),e=>e.status===503&&e.code==='NG_ASSIGNMENT_OUTCOME_UNCERTAIN');assert.equal(discarded,true);
});
