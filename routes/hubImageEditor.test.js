import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { mountHubImageEditorRoutes } from './hubImageEditor.js';
import { normalizeHubTarget, normalizeHubFrame, inspectHubImage } from '../lib/hubImageEditor.js';

const PNG=await sharp({create:{width:80,height:60,channels:3,background:'#d22'}}).png().toBuffer();
function setup({privateBucket=true,dbFails=false,manifestFails=false,role='editor_contenido',commitThenError=false,beforeUpdate}={}){
  const objects=new Map(),rows=new Map([['sport',{deporte:'padbol',card_key:'crear_partido',imagen_url:null}],['inicio',{id:'hub_inicio_card_1',foto_url:null}],['inicio2',{id:'hub_inicio_card_2',foto_url:null}],['inicio3',{id:'hub_inicio_card_3',foto_url:null}],['inicio4',{id:'hub_inicio_card_4',foto_url:null}]]),calls=[];
  const client={storage:{getBucket:async()=>({data:{public:!privateBucket},error:null}),from:bucket=>({
    upload:async(path,bytes,opts)=>{calls.push(['upload',bucket,path]);if(manifestFails&&path.endsWith('manifest.json'))return{error:Error('write failed')};objects.set(`${bucket}/${path}`,new Blob([bytes],{type:opts.contentType}));return{error:null};},
    getPublicUrl:path=>({data:{publicUrl:`https://cdn.invalid/storage/v1/object/public/${bucket}/${path}`}}),
    download:async path=>({data:objects.get(`${bucket}/${path}`),error:objects.has(`${bucket}/${path}`)?null:Error('not found')}),
    remove:async paths=>{for(const path of paths)objects.delete(`${bucket}/${path}`);return{error:null};},
  })},from:table=>{
    const filters={};let payload=null,inserting=false;const q={select:()=>q,eq:(k,v)=>{filters[k]=v;return q;},is:(k,v)=>{filters[k]=v;return q;},update:value=>{payload=value;inserting=false;return q;},insert:value=>{payload=value;inserting=true;return q;},maybeSingle:async()=>{
      if(payload && beforeUpdate)beforeUpdate(rows);
      if(inserting){if(dbFails)return{error:Error('DB failed')};const conflict=[...rows.values()].some(r=>r.deporte===payload.deporte&&r.card_key===payload.card_key);if(conflict)return{error:Object.assign(Error('duplicate'),{code:'23505'})};const made={id:'new-'+rows.size,...payload};rows.set('new-'+rows.size,made);calls.push(['db',table]);return{data:{...made},error:null};}
      const row=[...rows.values()].find(r=>Object.entries(filters).every(([k,v])=>r[k]===v))||null;
      if(!payload)return{data:row,error:null};
      if(dbFails)return{error:Error('DB failed')};
      if(!row)return{data:null,error:null};
      calls.push(['db',table]);Object.assign(row,payload);
      return commitThenError?{error:Error('lost response')}:{data:{...row},error:null};
    }};return q;
  }};
  const app=express();mountHubImageEditorRoutes(app,{supabaseAdmin:client,getAuthenticatedUser:async req=>req.headers['x-user']?{user:{id:'u',email:'editor@test.invalid'},status:200}:{user:null,status:401},fetchUserRoleRowForAuthUser:async()=>({role})});
  return{app,objects,rows,calls};
}
async function serve(app,fn){const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{await fn(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}}
const target={kind:'deporte',deporte:'padbol',card_key:'crear_partido'};
const frame={version:1,pixels:{x:-30,y:-5,width:140,height:90},viewport:{width:100,height:64}};
function body({source_id,original=true,final=PNG,originalUrl,expectedImage=null}={}){const f=new FormData();f.append('target',JSON.stringify(target));f.append('frame',JSON.stringify(frame));f.append('expected_image_url',JSON.stringify(expectedImage));f.append('foto',new Blob([final],{type:'image/png'}),'final.png');if(original)f.append('original',new Blob([PNG],{type:'image/png'}),'source.png');if(source_id)f.append('source_id',source_id);if(originalUrl)f.append('original_url',originalUrl);return f;}
const post=(base,form,auth=true)=>fetch(`${base}/api/admin/hub-images/edit`,{method:'POST',headers:auth?{'x-user':'editor'}:{},body:form});
test('private original + frame survive reopening and recropping; app retains public final URL only',async()=>{
  const h=setup();await serve(h.app,async base=>{
    const r=await post(base,body());assert.equal(r.status,201);const saved=await r.json();assert.deepEqual(saved.frame,frame);assert.equal(saved.row.imagen_url,saved.image_url);
    assert.equal(h.calls.filter(c=>c[0]==='upload'&&c[1]==='hub-images').length,1);
    assert.ok(![...h.objects.keys()].some(k=>k.startsWith('hub-images/')&&k.includes('original')));
    const get=await fetch(`${base}/api/admin/hub-images/source?kind=deporte&deporte=padbol&card_key=crear_partido`,{headers:{'x-user':'editor'}});assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'private, no-store');const reopened=await get.json();assert.equal(reopened.source_id,saved.source_id);
    const anon=await fetch(`${base}${reopened.original_url}`);assert.equal(anon.status,401);
    const original=await fetch(`${base}${reopened.original_url}`,{headers:{'x-user':'editor'}});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),PNG);
    const recrop=await post(base,body({original:false,source_id:saved.source_id,expectedImage:saved.image_url}));assert.equal(recrop.status,201);const next=await recrop.json();assert.notEqual(next.source_id,saved.source_id);assert.deepEqual(next.original,saved.original);
  });
});
test('auth before multipart/storage; private bucket required; DB and manifest errors retain previous config',async()=>{
  for(const opts of [{},{privateBucket:false},{dbFails:true},{manifestFails:true}]){
    const h=setup(opts);await serve(h.app,async base=>{
      const noAuth=await post(base,body(),false);assert.equal(noAuth.status,401);assert.equal(h.calls.length,0);
      const r=await post(base,body());assert.equal(r.status,opts.privateBucket===false?503:opts.dbFails||opts.manifestFails?500:201);
      if(opts.privateBucket===false||opts.dbFails||opts.manifestFails){assert.equal(h.rows.size,5);assert.equal(h.rows.get('sport').imagen_url,null);assert.equal(h.objects.size,0);}
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
    const first=await(await post(base,body())).json();const wrong=body({original:false,source_id:first.source_id});wrong.set('target',JSON.stringify({kind:'inicio',id:'hub_inicio_card_2'}));const r=await post(base,wrong);assert.equal(r.status,409);assert.equal((await r.json()).code,'SOURCE_TARGET_MISMATCH');
  });
});
test('HTTP inicio real hub_inicio_card_1 saves/reopens and rejects invented IDs',async()=>{
 const h=setup();await serve(h.app,async base=>{
  const inicio=body();inicio.set('target',JSON.stringify({kind:'inicio',id:'hub_inicio_card_1'}));const ok=await post(base,inicio);assert.equal(ok.status,201);const saved=await ok.json();assert.equal(saved.row.id,'hub_inicio_card_1');assert.equal(saved.row.foto_url,saved.image_url);
  const get=await fetch(`${base}/api/admin/hub-images/source?kind=inicio&id=hub_inicio_card_1`,{headers:{'x-user':'editor'}});assert.equal(get.status,200);const reopened=await get.json();assert.equal(reopened.source_id,saved.source_id);
  for(const id of ['inicio_jugar','hub_inicio_card_5','hub_inicio_card_1_extra']){const bad=body();bad.set('target',JSON.stringify({kind:'inicio',id}));const r=await post(base,bad);assert.equal(r.status,400);}
 });
});
test('non-editor roles denied before storage; success after lost DB response preserves published image',async()=>{
  for(const role of ['jugador','admin_club','admin_nacional']){const h=setup({role});await serve(h.app,async base=>{const r=await post(base,body());assert.equal(r.status,403);assert.equal(h.calls.length,0);});}
  const h=setup({commitThenError:true});await serve(h.app,async base=>{const r=await post(base,body());assert.equal(r.status,201);const saved=await r.json();assert.equal(saved.row.imagen_url,saved.image_url);assert.equal(h.objects.size,3);});
});

test('new Next Generation target creates one row with CAS null and duplicate create conflicts',async()=>{
 const h=setup();await serve(h.app,async base=>{
  const form=body();form.set('target',JSON.stringify({kind:'deporte',deporte:'padbol',card_key:'next_generation'}));const r=await post(base,form);assert.equal(r.status,201);assert.equal(h.rows.size,6);assert.equal(h.rows.get('new-5').card_key,'next_generation');
  const community=body();community.set('target',JSON.stringify({kind:'deporte',deporte:'padbol',card_key:'comunidad'}));const cr=await post(base,community);assert.equal(cr.status,201);assert.ok([...h.rows.values()].some(r=>r.card_key==='comunidad'));
  const again=body();again.set('target',JSON.stringify({kind:'deporte',deporte:'padbol',card_key:'next_generation'}));const conflict=await post(base,again);assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'HUB_IMAGE_CHANGED');assert.equal(h.rows.size,7);
 });
});
test('stale editors and missing targets fail without uploads; atomic pointer comparison rejects a concurrent publisher',async()=>{
 const h=setup();await serve(h.app,async base=>{
  const first=await(await post(base,body())).json();const uploads=h.calls.length;
  const stale=await post(base,body({original:false,source_id:first.source_id}));assert.equal(stale.status,409);assert.equal((await stale.json()).code,'HUB_IMAGE_CHANGED');assert.equal(h.calls.length,uploads);
  const absent=body();absent.set('target',JSON.stringify({kind:'legacy',id:'arbitrary_new_card'}));const r=await post(base,absent);assert.equal(r.status,404);assert.equal((await r.json()).code,'HUB_TARGET_NOT_FOUND');assert.equal(h.rows.size,5);assert.equal(h.calls.length,uploads);
 });
 const concurrent=setup({beforeUpdate:rows=>{rows.get('sport').imagen_url='https://cdn.invalid/newer.jpg';}});await serve(concurrent.app,async base=>{
  const r=await post(base,body());assert.equal(r.status,409);assert.equal((await r.json()).code,'HUB_IMAGE_CHANGED');assert.equal(concurrent.rows.get('sport').imagen_url,'https://cdn.invalid/newer.jpg');assert.equal(concurrent.objects.size,0);
 });
});
