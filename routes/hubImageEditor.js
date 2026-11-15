import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { requireContentEditorUser } from '../lib/authAccess.js';
import { HUB_EDITOR_BUCKET, HUB_EDITOR_ORIGINAL_LIMIT, HUB_EDITOR_FINAL_LIMIT, editorError, parseEditorJson, normalizeHubTarget, normalizeHubFrame, inspectHubImage, hubTargetQuery, hubRowImage, sourceFromFinalUrl, requirePrivateHubBucket, downloadEditorManifest, validSourceId } from '../lib/hubImageEditor.js';

const ROOT='/api/admin/hub-images';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:HUB_EDITOR_ORIGINAL_LIMIT,files:2,fields:4,fieldSize:8192}}).fields([{name:'original',maxCount:1},{name:'foto',maxCount:1}]);
const sameTarget=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const dto=(m)=>({source_id:m.source_id,image_url:m.image_url,frame:m.frame,original:m.original,original_url:`${ROOT}/source/${m.source_id}/original`});
export function mountHubImageEditorRoutes(app,{supabaseAdmin,...authDeps}) {
  const auth=async(req,res,next)=>{try{if(await requireContentEditorUser(req,res,authDeps))next();}catch{res.status(401).json({code:'UNAUTHORIZED'});}};
  const fail=(res,e)=>res.status(e.status || 500).json({code:e.code || 'HUB_EDITOR_FAILED',error:e.code || 'HUB_EDITOR_FAILED'});
  app.get(`${ROOT}/source`,auth,async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try {
      const target=normalizeHubTarget(req.query);
      const {data:row,error}=await hubTargetQuery(supabaseAdmin,target).maybeSingle();
      if(error)throw error;
      const id=sourceFromFinalUrl(hubRowImage(row,target));
      if(!id)throw editorError('SOURCE_NOT_AVAILABLE',404);
      await requirePrivateHubBucket(supabaseAdmin);
      const m=await downloadEditorManifest(supabaseAdmin,id);
      if(!sameTarget(m.target,target) || m.image_url!==hubRowImage(row,target))throw editorError('SOURCE_NOT_AVAILABLE',404);
      res.json(dto(m));
    }catch(e){fail(res,e);}
  });
  app.get(`${ROOT}/source/:sourceId/original`,auth,async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try {
      await requirePrivateHubBucket(supabaseAdmin);
      const m=await downloadEditorManifest(supabaseAdmin,req.params.sourceId);
      const {data,error}=await supabaseAdmin.storage.from(HUB_EDITOR_BUCKET).download(`editor/v1/${m.source_id}/original.${m.original.ext}`);
      if(error || !data)throw editorError('SOURCE_NOT_AVAILABLE',404);
      const bytes=Buffer.from(await data.arrayBuffer());
      if(bytes.length>HUB_EDITOR_ORIGINAL_LIMIT)throw editorError('INVALID_HUB_IMAGE');
      res.set('Content-Type',m.original.mime);res.set('X-Content-Type-Options','nosniff');res.send(bytes);
    }catch(e){fail(res,e);}
  });
  app.post(`${ROOT}/edit`,auth,upload,async(req,res)=>{
    const uploadedPrivate=[],uploadedPublic=[];
    let publication=null;
    try {
      const target=normalizeHubTarget(parseEditorJson(req.body.target));
      const frame=normalizeHubFrame(parseEditorJson(req.body.frame));
      const finalFile=req.files?.foto?.[0];
      const final=await inspectHubImage(finalFile,HUB_EDITOR_FINAL_LIMIT);
      let originalFile=req.files?.original?.[0],original;
      await requirePrivateHubBucket(supabaseAdmin);
      if(originalFile && req.body.source_id)throw editorError('AMBIGUOUS_ORIGINAL');
      if(originalFile)original=await inspectHubImage(originalFile,HUB_EDITOR_ORIGINAL_LIMIT);
      else {
        if(!validSourceId(req.body.source_id))throw editorError('ORIGINAL_REQUIRED');
        const old=await downloadEditorManifest(supabaseAdmin,req.body.source_id);
        if(!sameTarget(old.target,target))throw editorError('SOURCE_TARGET_MISMATCH',409);
        const {data,error}=await supabaseAdmin.storage.from(HUB_EDITOR_BUCKET).download(`editor/v1/${old.source_id}/original.${old.original.ext}`);
        if(error || !data)throw editorError('SOURCE_NOT_AVAILABLE',404);
        originalFile={buffer:Buffer.from(await data.arrayBuffer()),mimetype:old.original.mime};
        original=await inspectHubImage(originalFile,HUB_EDITOR_ORIGINAL_LIMIT);
      }
      const id=randomUUID(),prefix=`editor/v1/${id}`;
      const originalPath=`${prefix}/original.${original.ext}`,finalPath=`${prefix}/final.${final.ext}`,manifestPath=`${prefix}/manifest.json`;
      const privateStore=supabaseAdmin.storage.from(HUB_EDITOR_BUCKET),publicStore=supabaseAdmin.storage.from('hub-images');
      const put=async(store,path,bytes,mime,track)=>{const {error}=await store.upload(path,bytes,{contentType:mime,upsert:false});if(error)throw error;track.push(path);};
      await put(privateStore,originalPath,originalFile.buffer,original.mime,uploadedPrivate);
      await put(publicStore,finalPath,finalFile.buffer,final.mime,uploadedPublic);
      const image_url=publicStore.getPublicUrl(finalPath)?.data?.publicUrl;
      if(!/^https:\/\//.test(image_url || ''))throw editorError('INVALID_PUBLIC_IMAGE_URL',500);
      const manifest={version:1,source_id:id,target,frame,original,image_url};
      await put(privateStore,manifestPath,Buffer.from(JSON.stringify(manifest)),'application/json',uploadedPrivate);
      const table=target.kind==='deporte'?'hub_deporte_config':'hub_config';
      const payload=target.kind==='deporte'?{deporte:target.deporte,card_key:target.card_key,imagen_url:image_url}:{id:target.id,foto_url:image_url};
      publication={target,manifest};
      const {data:row,error}=await supabaseAdmin.from(table).upsert(payload,{onConflict:target.kind==='deporte'?'deporte,card_key':'id'}).select('*').single();
      if(error)throw error;
      res.status(201).json({row,...dto(manifest)});
    }catch(e){
      // A network failure after DB commit must never delete the image the app now uses.
      // Confirm the current pointer; preserve immutable assets if the outcome is unknown.
      if(publication){
        try {
          const {data:row,error}=await hubTargetQuery(supabaseAdmin,publication.target).maybeSingle();
          if(error)throw error;
          if(hubRowImage(row,publication.target)===publication.manifest.image_url)return res.status(201).json({row,...dto(publication.manifest)});
        }catch{return fail(res,editorError('HUB_EDITOR_PUBLICATION_UNCONFIRMED',503));}
      }
      if(uploadedPrivate.length)await supabaseAdmin.storage.from(HUB_EDITOR_BUCKET).remove(uploadedPrivate).catch(()=>{});
      if(uploadedPublic.length)await supabaseAdmin.storage.from('hub-images').remove(uploadedPublic).catch(()=>{});
      fail(res,e);
    }
  });
  app.use(ROOT,(e,_req,res,next)=>{if(e instanceof multer.MulterError)return res.status(400).json({code:e.code==='LIMIT_FILE_SIZE'?'IMAGE_TOO_LARGE':'INVALID_EDITOR_UPLOAD'});next(e);});
}
