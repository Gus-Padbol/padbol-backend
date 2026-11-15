import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { mountHubImageEditorRoutes } from './hubImageEditor.js';
import { normalizeHubTarget, normalizeHubFrame, inspectHubImage } from '../lib/hubImageEditor.js';

const PNG=await sharp({create:{width:80,height:60,channels:3,background:'#d22'}}).png().toBuffer();
function setup({privateBucket=true,dbFails=false,manifestFails=false,role='editor_contenido',commitThenError=false}={}){
  const objects=new Map(),rows=new Map(),calls=[];
  const client={storage:{getBucket:async()=>({data:{public:!privateBucket},error:null}),from:bucket=>({
    upload:async(path,bytes,opts)=>{calls.push(['upload',bucket,path]);if(manifestFails&&path.endsWith('manifest.json'))return{error:Error('write failed')};objects.set(`${bucket}/${path}`,new Blob([bytes],{type:opts.contentType}));return{error:null};},
    getPublicUrl:path=>({data:{publicUrl:`https://cdn.invalid/storage/v1/object/public/${bucket}/${path}`}}),
    download:async path=>({data:objects.get(`${bucket}/${path}`),error:objects.has(`${bucket}/${path}`)?null:Error('not found')}),
    remove:async paths=>{for(const path of paths)objects.delete(`${bucket}/${path}`);return{error:null};},
  })},from:table=>{
    const filters={};const q={select:()=>q,eq:(k,v)=>{filters[k]=v;return q;},maybeSingle:async()=>({data:[...rows.values()].find(r=>Object.entries(filters).every(([k,v])=>r[k]===v))||null,error:null}),
      upsert:payload=>({select:()=>({single:async()=>{if(dbFails)return{error:Error('DB failed')};calls.push(['db',table]);rows.set(JSON.stringify([table,payload.id??payload.deporte,payload.card_key]),payload);return commitThenError?{error:Error('lost response')}:{data:payload,error:null};}})})};return q;
  }};
  const app=express();mountHubImageEditorRoutes(app,{supabaseAdmin:client,getAuthenticatedUser:async req=>req.headers['x-user']?{user:{id:'u',email:'editor@test.invalid'},status:200}:{user:null,status:401},fetchUserRoleRowForAuthUser:async()=>({role})});
  return{app,objects,rows,calls};
}
async function serve(app,fn){const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{await fn(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}}
const target={kind:'deporte',deporte:'padbol',card_key:'crear_partido'};
const frame={version:1,pixels:{x:-30,y:-5,width:140,height:90},viewport:{width:100,height:64}};
function body({source_id,original=true,final=PNG,originalUrl}={}){const f=new FormData();f.append('target',JSON.stringify(target));f.append('frame',JSON.stringify(frame));f.append('foto',new Blob([final],{type:'image/png'}),'final.png');if(original)f.append('original',new Blob([PNG],{type:'image/png'}),'source.png');if(source_id)f.append('source_id',source_id);if(originalUrl)f.append('original_url',originalUrl);return f;}
const post=(base,form,auth=true)=>fetch(`${base}/api/admin/hub-images/edit`,{method:'POST',headers:auth?{'x-user':'editor'}:{},body:form});
test('private original + frame survive reopening and recropping; app retains public final URL only',async()=>{
  const h=setup();await serve(h.app,async base=>{
    const r=await post(base,body());assert.equal(r.status,201);const saved=await r.json();assert.deepEqual(saved.frame,frame);assert.equal(saved.row.imagen_url,saved.image_url);
    assert.equal(h.calls.filter(c=>c[0]==='upload'&&c[1]==='hub-images').length,1);
    assert.ok(![...h.objects.keys()].some(k=>k.startsWith('hub-images/')&&k.includes('original')));
    const get=await fetch(`${base}/api/admin/hub-images/source?kind=deporte&deporte=padbol&card_key=crear_partido`,{headers:{'x-user':'editor'}});assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'private, no-store');const reopened=await get.json();assert.equal(reopened.source_id,saved.source_id);
    const anon=await fetch(`${base}${reopened.original_url}`);assert.equal(anon.status,401);
    const original=await fetch(`${base}${reopened.original_url}`,{headers:{'x-user':'editor'}});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),PNG);
    const recrop=await post(base,body({original:false,source_id:saved.source_id}));assert.equal(recrop.status,201);const next=await recrop.json();assert.notEqual(next.source_id,saved.source_id);assert.deepEqual(next.original,saved.original);
  });
});
test('auth before multipart/storage; private bucket required; DB and manifest errors retain previous config',async()=>{
  for(const opts of [{},{privateBucket:false},{dbFails:true},{manifestFails:true}]){
    const h=setup(opts);await serve(h.app,async base=>{
      const noAuth=await post(base,body(),false);assert.equal(noAuth.status,401);assert.equal(h.calls.length,0);
      const r=await post(base,body());assert.equal(r.status,opts.privateBucket===false?503:opts.dbFails||opts.manifestFails?500:201);
      if(opts.privateBucket===false||opts.dbFails||opts.manifestFails){assert.equal(h.rows.size,0);assert.equal(h.objects.size,0);}
    });
  }
});
test('old images unavailable; no source URL fetching, traversal, wrong target, invalid images rejected',async()=>{
  assert.throws(()=>normalizeHubTarget({kind:'deporte',deporte:'../x',card_key:'a'}));assert.throws(()=>normalizeHubFrame({pixels:{x:0,y:0,width:-1,height:2}}));
  await assert.rejects(inspectHubImage({buffer:Buffer.from('<svg/>'),mimetype:'image/png'},100));
  const h=setup();await serve(h.app,async base=>{
    const old=await fetch(`${base}/api/admin/hub-images/source?kind=legacy&id=crear_partido`,{headers:{'x-user':'editor'}});assert.equal(old.status,404);assert.equal((await old.json()).code,'SOURCE_NOT_AVAILABLE');
    const ssrf=await post(base,body({original:false,originalUrl:'http://169.254.169.254/metadata'}));assert.equal(ssrf.status,400);assert.equal(h.calls.length,0);
    const invalid=await post(base,body({final:Buffer.from('not an image')}));assert.equal(invalid.status,400);assert.equal(h.calls.length,0);
    const first=await(await post(base,body())).json();const wrong=body({original:false,source_id:first.source_id});wrong.set('target',JSON.stringify({kind:'inicio',id:'inicio_jugar'}));const r=await post(base,wrong);assert.equal(r.status,409);assert.equal((await r.json()).code,'SOURCE_TARGET_MISMATCH');
  });
});
test('non-editor roles denied before storage; success after lost DB response preserves published image',async()=>{
  for(const role of ['jugador','admin_club','admin_nacional']){const h=setup({role});await serve(h.app,async base=>{const r=await post(base,body());assert.equal(r.status,403);assert.equal(h.calls.length,0);});}
  const h=setup({commitThenError:true});await serve(h.app,async base=>{const r=await post(base,body());assert.equal(r.status,201);const saved=await r.json();assert.equal(saved.row.imagen_url,saved.image_url);assert.equal(h.objects.size,3);});
});
