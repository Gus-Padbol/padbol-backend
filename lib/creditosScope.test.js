import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isAdminClubOrSuper,resolveAuthRoleForUser,requireAuthenticatedUser} from './authAccess.js';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf("app.get('/api/creditos/:email',");
assert.ok(start>=0);
const route=source.slice(start,source.indexOf('\n});',start)+5);
const customer='customer@example.invalid',owner='owner@example.invalid';
const rows=[
 {id:1,email:customer,sede_id:7,monto:100},{id:2,email:customer,sede_id:8,monto:200},{id:3,email:customer,sede_id:null,monto:50},
 {id:4,email:customer,sede_id:7,monto:400,vence_at:'2000-01-01T00:00:00Z'},
 {id:5,email:customer,sede_id:7,monto:800,usado:true},{id:6,email:'different@example.invalid',sede_id:7,monto:900},
 {id:7,email:owner,sede_id:7,monto:10},{id:8,email:owner,sede_id:8,monto:20},{id:9,email:owner,sede_id:null,monto:30},
].map(row=>({usado:false,vence_at:'2099-01-01T00:00:00Z',created_at:'2026-01-01T00:00:00Z',...row}));
async function run(role,{email=customer,authenticated=true,dbError=false,query={},metadata={},roleError=false,sourceText=source}={}){
 let handler,queries=0,roleReads=0;const filters=[];
 const q={select(fields){assert.equal(fields,'id, monto, sede_id, created_at, vence_at');return this;},eq(k,v){filters.push(['eq',k,v]);return this;},gt(k,v){filters.push(['gt',k,v]);return this;},order(k,{ascending}){assert.equal(k,'created_at');assert.equal(ascending,false);return this;},async limit(limit){assert.equal(limit,20);if(dbError)return{error:Error('private database message')};return{data:rows.filter(row=>filters.every(([op,k,v])=>op==='eq'?row[k]===v:row[k]>v)).slice(0,limit).map(({id,monto,sede_id,created_at,vence_at})=>({id,monto,sede_id,created_at,vence_at}))};}};
 const user={id:'synthetic-owner',email:' Owner@Example.Invalid ',user_metadata:metadata};
 const offset=sourceText.indexOf("app.get('/api/creditos/:email',");const routeUnderTest=sourceText.slice(offset,sourceText.indexOf("\n});",offset)+5);
 vm.runInNewContext(routeUnderTest,{app:{get(_path,fn){handler=fn;}},requireAuthenticatedUser,getAuthenticatedUser:async()=>authenticated?{user}:{user:null,status:401,error:'No autorizado'},resolveAuthRoleForUser,fetchUserRoleRowForAuthUser:async()=>{roleReads++;if(roleError)throw Error('role source unavailable');return role;},LEGACY_SUPER_ADMIN_EMAILS_API:[owner],isAdminClubOrSuper,supabaseAdmin:{from(table){assert.equal(table,'creditos');queries++;return q;}},maskEmail:()=>'<synthetic>',console:{log(){},error(){}},sendHttpError:res=>res.status(500).json({error:'safe'})});
 const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 await handler({params:{email},query,user:{role:'super_admin',sede_id:8}},res);return{res,filters,queries,roleReads};
}
for(const [venue,ids,total] of [[7,[1],100],[8,[2],200]])test(`trusted admin of venue${venue} sees only its customer credits`,async()=>{
 const{res,filters}=await run({role:'admin_club',sede_id:venue});assert.equal(res.code,200);assert.deepEqual(Array.from(res.body.creditos,x=>x.id),ids);assert.equal(res.body.total,total);assert.ok(filters.some(([op,k,v])=>op==='eq'&&k==='sede_id'&&v===venue));
});
test('forged venue query and body-like user fields do not override persisted venue',async()=>{
 const{res}=await run({role:'admin_club',sede_id:7},{query:{sede_id:8,role:'super_admin'}});assert.equal(res.body.total,100);assert.deepEqual(Array.from(res.body.creditos,x=>x.id),[1]);
});
test('superadmin retains customer scope across A B and unassigned history',async()=>{const{res,filters}=await run({role:'super_admin'});assert.equal(res.body.total,350);assert.deepEqual(Array.from(res.body.creditos,x=>x.id),[1,2,3]);assert.ok(!filters.some(([,k])=>k==='sede_id'));});
for(const role of [{role:'jugador'},{role:'admin_club',sede_id:7},{role:'admin_club',sede_id:8}])test(`personal ownership remains cross-venue for ${JSON.stringify(role)}`,async()=>{
 const{res,filters}=await run(role,{email:'%20OWNER%40EXAMPLE.INVALID%20'});assert.equal(res.body.total,60);assert.deepEqual(Array.from(res.body.creditos,x=>x.id),[7,8,9]);assert.ok(!filters.some(([,k])=>k==='sede_id'));
});
for(const role of [null,{role:'jugador'},{role:'admin_club'},{role:'admin_club',sede_id:0},{role:'admin_club',sede_id:7.5},{role:'admin_club',sede_id:'not-a-venue'}])test(`untrusted or invalid club role denies foreign credit read ${JSON.stringify(role)}`,async()=>{
 const{res,queries}=await run(role,{metadata:{role:'super_admin',sede_id:7}});assert.equal(res.code,403);assert.equal(queries,0);assert.equal(res.body.creditos,undefined);
});
test('missing session returns401 before role lookup and data query',async()=>{const{res,queries,roleReads}=await run({role:'super_admin'},{authenticated:false});assert.equal(res.code,401);assert.equal(queries,0);assert.equal(roleReads,0);});
test('database failure exposes no total or private metadata',async()=>{const{res}=await run({role:'admin_club',sede_id:7},{dbError:true});assert.equal(res.code,500);assert.equal(res.body.creditos,undefined);assert.equal(res.body.total,undefined);assert.ok(!JSON.stringify(res.body).includes('private'));});
test('role lookup outage returns no credits rather than broadening scope',async()=>{const{res,queries}=await run({role:'admin_club',sede_id:7},{roleError:true});assert.equal(res.code,500);assert.equal(queries,0);});

export {run};
