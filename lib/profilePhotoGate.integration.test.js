import test from 'node:test'; import assert from 'node:assert/strict';
import express from 'express'; import {createServer} from 'node:http'; import {once} from 'node:events';
import {createProfilePhotoGate} from './profilePhotoGate.js'; import {decodeProfilePhoto} from './profilePhotoPayload.js';

const okLimit=(req,res,next)=>next();
const deny429=(req,res)=>res.status(429).json({error:'rate'});
async function appWith({authenticate=()=>({user:{id:'u1'}}), ipLimit=okLimit, userLimit=okLimit, bodyLimit='5mb'}={}) {
  const app=express(); app.use(createProfilePhotoGate({authenticate, ipLimit, userLimit}));
  app.use(express.json()); app.post('/api/usuarios/foto-perfil',(req,res)=>{ const p=decodeProfilePhoto(req.body||{}); if(p.error) return res.status(p.error.status).json({error:p.error.error,code:p.error.code}); res.json({bytes:p.buffer.length}); });
  const s=createServer(app); s.listen(0,'127.0.0.1'); await once(s,'listening'); return {base:`http://127.0.0.1:${s.address().port}`,close:()=>s.close()};
}
const b64=(n)=>Buffer.alloc(n).toString('base64');
const post=(base,body)=>fetch(`${base}/api/usuarios/foto-perfil`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('noauth 401 antes de parsear body grande',async()=>{const {base,close}=await appWith({authenticate:()=>({user:null,status:401,error:'No autorizado'})});try{const r=await post(base,{foto_base64:b64(6*1024*1024)});assert.equal(r.status,401);}finally{close();}});
test('429 del limitador por usuario',async()=>{const {base,close}=await appWith({userLimit:deny429});try{const r=await post(base,{foto_base64:b64(100)});assert.equal(r.status,429);}finally{close();}});
test('imagen valida >100KB pasa y devuelve bytes',async()=>{const {base,close}=await appWith();try{const r=await post(base,{foto_base64:b64(300*1024)});assert.equal(r.status,200);assert.equal((await r.json()).bytes,300*1024);}finally{close();}});
test('Buffer 5MiB+1 -> 400 PHOTO_TOO_LARGE con JSON <8MiB',async()=>{const {base,close}=await appWith();const n=5*1024*1024+1;try{const r=await post(base,{foto_base64:b64(n)});assert.equal(r.status,400);const j=await r.json();assert.equal(j.code,'PHOTO_TOO_LARGE');}finally{close();}});
test('5MiB exactos pasan',async()=>{const {base,close}=await appWith();try{const r=await post(base,{foto_base64:b64(5*1024*1024)});assert.equal(r.status,200);}finally{close();}});
test('JSON >8MiB -> 413',async()=>{const {base,close}=await appWith();try{const r=await post(base,{foto_base64:'A'.repeat(9*1024*1024)});assert.equal(r.status,413);}finally{close();}});
test('GET y subruta no pasan por gate de foto',async()=>{const app=express();app.use(createProfilePhotoGate({authenticate:()=>({user:{id:'u'}}),ipLimit:okLimit,userLimit:okLimit}));app.use(express.json());app.get('/api/usuarios/foto-perfil',(q,s)=>s.json({ok:1}));app.post('/api/usuarios/foto-perfil/x',(q,s)=>s.json({ok:1}));const srv=createServer(app);srv.listen(0,'127.0.0.1');await once(srv,'listening');const base=`http://127.0.0.1:${srv.address().port}`;try{const g=await fetch(`${base}/api/usuarios/foto-perfil`);assert.equal(g.status,200);const sub=await fetch(`${base}/api/usuarios/foto-perfil/x`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(sub.status,200);}finally{srv.close();}});
