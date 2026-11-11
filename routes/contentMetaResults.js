import express from 'express';
import multer from 'multer';
import {createContentMetaResults} from '../lib/contentMetaResults.js';
import {readMetaMonitorStatus} from '../lib/contentMetaMonitor.js';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024,files:1,fields:8}});
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'');
export function createContentMetaRouter(deps){
 const router=express.Router();let service,importBusy=false;
 router.use((req,res,next)=>{if(!req.workspaceAuth?.canDecidePromotion)return res.status(403).json({error:'Los resultados corresponden a dirección y coordinación.'});if(!deps.pgPool)return res.status(503).json({error:'Los resultados no están disponibles temporalmente.'});service??=createContentMetaResults({pool:deps.pgPool,env:deps.env||process.env});next();});
 const errors={FORBIDDEN:'No tienes permiso para acceder a estos resultados.',WRONG_ACCOUNT:'El archivo no corresponde a la cuenta autorizada.',INVALID_DAILY_DATE:'Las fechas deben ser días válidos, sin intervalos ni fechas futuras.',OVERLAPPING_IMPORT:'Ya hay datos para estas fechas y nivel. Confirma el reemplazo de esas fechas.',HASH_MISMATCH:'El archivo cambió. Vuelve a generar la vista previa.',SOURCE_METADATA_CONFLICT:'El mismo archivo ya se cargó con otros datos de origen. Revisa su importación.',PREVIEW_EXPIRED:'La vista previa venció. Vuelve a cargar el archivo.',META_READ_CONNECTION_NOT_CONFIGURED:'Todavía falta configurar la autorización de solo lectura de Meta.',META_READ_ACCESS_FAILED:'Meta no permitió leer la cuenta. Revisa su autorización ads_read.',META_READ_ACCOUNT_MISMATCH:'La cuenta Meta no coincide con la cuenta, moneda y zona horaria autorizadas.',META_READ_TOO_MANY_ROWS:'El período es demasiado grande. Elige un rango menor.',META_READ_NO_DELIVERY:'Meta no devolvió filas para este período. No se reemplazaron datos.',NOT_FOUND:'Importación inexistente.'};
 const handle=(fn,status=200)=>async(req,res)=>{try{res.status(status).json(await fn(req,req.workspaceAuth.user.id));}catch(e){const status=e.status||503;res.status(status).json({error:errors[e.code]||(status===400?'Revisa el CSV, sus fechas, columnas e importes.':'No se pudieron cargar o guardar los resultados.'),code:e.code||'META_RESULTS_UNAVAILABLE'});}};
 router.get('/status',handle((r,a)=>service.status(a)));
 router.get('/monitor',handle((r,a)=>readMetaMonitorStatus({pool:deps.pgPool,actor:a,env:deps.env||process.env})));
 router.get('/insights',handle((r,a)=>service.insights(a,r.query)));
 router.post('/imports/preview',(req,res)=>{
  if(importBusy)return res.status(429).json({error:'Hay otra importación en curso. Vuelve a intentarlo cuando termine.',code:'IMPORT_BUSY'});
  importBusy=true;upload.single('file')(req,res,async err=>{try{if(err||!req.file)return res.status(400).json({error:'Sube un CSV UTF-8 de hasta 30 MB.',code:'INVALID_FILE'});await handle((r,a)=>service.preview(a,r.file.buffer,r.file.originalname,r.body),201)(req,res);}finally{importBusy=false;}});
 });
 router.post('/imports/:id/commit',handle((r,a)=>{if(!uuid(r.params.id)||!/^[a-f0-9]{64}$/.test(r.body?.hash||'')||typeof r.body.replace!=='boolean')throw Object.assign(Error('INVALID_COMMIT'),{status:400});return service.commit(a,r.params.id,r.body.hash,r.body.replace);}));
 router.get('/imports/:id/download',async(req,res)=>{try{if(!uuid(req.params.id))return res.sendStatus(404);const r=await service.original(req.workspaceAuth.user.id,req.params.id);res.type('text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="'+r.filename.replace(/[^a-zA-Z0-9_.-]/g,'_')+'"').send(r.raw_csv);}catch(e){res.status(e.status||503).json({error:'No se pudo descargar el original.'});}});
 router.post('/sync',handle((r,a)=>service.sync(a,r.body)));
 return router;
}
