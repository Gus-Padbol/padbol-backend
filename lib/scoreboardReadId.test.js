import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import {isScoreboardReadId} from './scoreboardReadId.js';
import {sendHttpError} from './httpErrors.js';
const source=readFileSync(new URL('../routes/scoreboard.js',import.meta.url),'utf8');
const start=source.indexOf("  app.get('/api/scoreboard/partidos/:id',");
const route=source.slice(start,source.indexOf('\n  });',start)+7);
const fetchStart=source.indexOf('async function fetchPartido(');
const fetchSource=source.slice(fetchStart,source.indexOf('\nasync function savePartido',fetchStart));
const known='a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const accepted=[known,known.toUpperCase(),'00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff',known.replaceAll('-',''),'{'+known+'}','a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11','{a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11}'];
const invalid=['0','1','-1','null','undefined','garbage','12121212-1212-4212-8212-12121212121g',known+'-','{'+known,known+'}',known+' OR true',known+' ',known+'/extra'];
function fixture({dbError=null,denied=false,baseline=false}={}){
 let handler,reads=0,access=0;
 const db={from(table){assert.equal(table,'scoreboard_partidos');let id;return{select(){return this},eq(k,v){assert.equal(k,'id');id=v;return this},async maybeSingle(){reads++;if(!isScoreboardReadId(id))return{data:null,error:Object.assign(Error('invalid input syntax for type uuid'),{code:'22P02'})};if(dbError)return{data:null,error:dbError};const normalized=id.replace(/[{}-]/g,'').toLowerCase();return{data:normalized===known.replaceAll('-','')?{id:known,sede_id:7,estado:'en_curso'}:null,error:null};}}}};
 const context={app:{get(_path,fn){handler=fn}},isScoreboardReadId,supabaseAdmin:db,SCOREBOARD_PARTIDO_SELECT:'id,sede_id,estado',assertNationsScoreboardRead:async()=>{access++;if(denied)throw Object.assign(Error('El sorteo todavía no está publicado.'),{status:403});},enrichPartidoWithVenue:async(_db,row)=>row,scoreboardSuspensionCandidateEnabled:false,scoreboardSuspensionRecoveryEnabled:false,sendHttpError,console:{error(){}}};
 const checkedRoute=baseline?route.replace(/      if \(!isScoreboardReadId\(req.params.id\)\) \{\n        return res.status\(400\).json\(\{ok:false,error:'Identificador de marcador inválido\.'\}\);\n      \}\n/,''):route;
 vm.runInNewContext(fetchSource+'\n'+checkedRoute,context);
 return{handler,get reads(){return reads},get access(){return access}};
}
async function request(f,id){const res={statusCode:200,status(v){this.statusCode=v;return this},json(body){this.body=body;return this}};await f.handler({params:{id}},res);return res;}
test('baseline reproduces malformed UUID0 as500 at actual read handler',async()=>{const f=fixture({baseline:true});const r=await request(f,'0');assert.equal(r.statusCode,500);assert.equal(f.reads,1);});
test('malformed inputs return400 before database or audience lookup',async()=>{for(const id of invalid){const f=fixture(),r=await request(f,id);assert.equal(r.statusCode,400,id);assert.equal(f.reads,0);assert.equal(f.access,0);}});
test('UUID versions and PostgreSQL documented alternate input forms stay accepted',async()=>{for(const id of accepted)assert.equal(isScoreboardReadId(id),true,id);for(const value of [null,undefined,0,{},[],true,''])assert.equal(isScoreboardReadId(value),false);});
test('valid existing uppercase compact and braced IDs preserve successful DTO',async()=>{for(const id of [known,known.toUpperCase(),known.replaceAll('-',''),'{'+known+'}']){const f=fixture(),r=await request(f,id);assert.equal(r.statusCode,200);assert.equal(r.body.id,known);assert.equal(r.body.scoreboard_partial_correction_enabled,true);assert.equal(f.reads,1);assert.equal(f.access,1);}});
test('syntactically valid missing UUID remains404',async()=>{const f=fixture(),r=await request(f,'ffffffff-ffff-4fff-bfff-ffffffffffff');assert.equal(r.statusCode,404);assert.equal(f.reads,1);assert.equal(f.access,0);});
test('valid ID preserves authorization403 rather than bypassing audience rules',async()=>{const f=fixture({denied:true}),r=await request(f,known);assert.equal(r.statusCode,403);assert.equal(f.access,1);});
test('internal database errors for valid UUID remain500, never relabeled malformed input',async()=>{for(const code of ['22P02','42P01','42501','08006']){const f=fixture({dbError:Object.assign(Error('private postgres relation detail'),{code})}),r=await request(f,known);assert.equal(r.statusCode,500);assert.equal(f.access,0);if(process.env.NODE_ENV==='production')assert.equal(r.body.error,'Error interno del servidor');}});
test('actual local HTTP GET malformed valid and missing paths, no writes or external transport',async()=>{
 const f=fixture();const server=http.createServer(async(req,res)=>{const id=decodeURIComponent(req.url.split('/').at(-1));const adapter={status(v){res.statusCode=v;return this},json(body){res.setHeader('content-type','application/json');res.end(JSON.stringify(body));return this}};await f.handler({params:{id}},adapter);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{for(const[id,status]of [['0',400],[known,200],['ffffffff-ffff-4fff-bfff-ffffffffffff',404]]){const response=await fetch(`http://127.0.0.1:${server.address().port}/api/scoreboard/partidos/${encodeURIComponent(id)}`);assert.equal(response.status,status);await response.json();}}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
