import express from 'express';
import multer from 'multer';
import {randomUUID} from 'node:crypto';
const bucket='content-workspace-private';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:1}});
import {requireAuthenticatedUser,resolveAuthRoleForUser} from '../lib/authAccess.js';
const states=new Set(['propuesto','preparando','revision','cambios','aprobado','publicado']);
const kinds=new Set(['original','editable','textless','final']);
const fields={title:180,brief:10000,campaign:120,topic:180,audience:180,language:40,format:60,assetKind:20,assetUrl:2000,deliveryDate:10,publishedAt:40,channel:80,profile:180,publicationUrl:2000,status:20,reviewNote:3000,assignedUserId:36};
export function validFileSignature(file){const b=file?.buffer;if(!b||b.length<4)return false;const m=file.mimetype;if(m==='application/pdf')return b.subarray(0,5).toString()==='%PDF-';if(m==='image/jpeg')return b[0]===255&&b[1]===216&&b[2]===255;if(m==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(m==='image/gif')return /^GIF8[79]a/.test(b.subarray(0,6).toString());if(m==='image/webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';if(m==='video/webm')return b.subarray(0,4).equals(Buffer.from([26,69,223,163]));return ['video/mp4','video/quicktime'].includes(m)&&b.subarray(4,8).toString()==='ftyp';}
export function validateWorkspaceInput(body,{create=false}={}){
 const out={};
 for(const [key,max] of Object.entries(fields))if(Object.hasOwn(body||{},key)){
  if(typeof body[key]!=='string'||body[key].length>max)throw Error('INVALID');
  out[key]=body[key].trim();
 }
 if(create&&!out.title)throw Error('INVALID');
 if(out.status&&!states.has(out.status))throw Error('INVALID');
 if(out.assetKind&&!kinds.has(out.assetKind))throw Error('INVALID');
 if(out.assignedUserId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.assignedUserId))throw Error('INVALID');
 for(const k of ['assetUrl','publicationUrl'])if(out[k]){let u;try{u=new URL(out[k]);}catch{throw Error('INVALID');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('INVALID');}
 if(out.deliveryDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(out.deliveryDate)||new Date(out.deliveryDate+'T00:00:00Z').toISOString().slice(0,10)!==out.deliveryDate))throw Error('INVALID');
 if(out.publishedAt&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(out.publishedAt)||new Date(out.publishedAt.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==out.publishedAt.slice(0,10)||!Number.isFinite(Date.parse(out.publishedAt))||!/(Z|[+-]\d{2}:\d{2})$/.test(out.publishedAt)))throw Error('INVALID');
 return out;
}
export async function enrichWorkspaceHistory(data,db){
 const history=Array.isArray(data?.history)?data.history:[];
 const ids=[...new Set([...history.map(h=>h.actorId),data?.item?.reviewedBy,data?.item?.promotionDecidedBy].filter(id=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id||'')))];
 let roles=[];
 if(ids.length)try{const r=await db.from('user_roles').select('user_id,nombre,role').in('user_id',ids);if(!r.error)roles=r.data||[];}catch{}
 const byId=new Map(roles.map(r=>[r.user_id,r]));
 const display=id=>{const r=byId.get(id);const name=String(r?.nombre||'').trim();return name&&!name.includes('@')&&!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name)?name.slice(0,120):'Coordinación';};
 return {...data,...(data?.item?{item:{...data.item,reviewerName:data.item.reviewedBy?display(data.item.reviewedBy):null,promotionDeciderName:data.item.promotionDecidedBy?display(data.item.promotionDecidedBy):null}}:{}),history:history.map(h=>{const r=byId.get(h.actorId),name=String(r?.nombre||'').trim();const safeName=name&&!name.includes('@')&&!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name)?name.slice(0,120):null;return {...h,actorName:safeName||(r?.role==='super_admin'?'Dirección':r?.role==='editor_contenido'?'Editor de contenido':'Usuario registrado')};})};
}
export function createContentWorkspaceRouter(deps){
 const router=express.Router();
 router.use(async(req,res,next)=>{try{const user=await requireAuthenticatedUser(req,res,deps.getAuthenticatedUser);if(!user)return;const role=await resolveAuthRoleForUser(user,deps);let canApprove=role.rol==='super_admin';let coordinator=false;{const r=await deps.supabaseAdmin.rpc('content_workspace_coordinator_access',{p_actor:user.id});if(r.error)throw r.error;if(r.data!==true&&role.rol!=='editor_contenido'&&role.rol!=='super_admin')return res.status(403).json({error:'No tenés permiso para gestionar contenido'});coordinator=r.data===true;canApprove=canApprove||coordinator;}let canManageCoordinators=false;if(role.rol==='super_admin'&&user.id==='8beebdbe-e1d7-4607-9bb0-9a7d64701408'){const owner=await deps.supabaseAdmin.rpc('crm_commercial_owner',{p_actor:user.id,p_superadmin:true});if(owner.error)throw owner.error;canManageCoordinators=owner.data===true;}req.workspaceAuth={user,role,canApprove,canManageCoordinators,canDecidePromotion:canManageCoordinators||coordinator};next();}catch{res.status(503).json({error:'No se pudo comprobar el acceso'});}});
 async function invoke(req,res,op){
  try{
   const a=req.workspaceAuth,create=op==='create';let patch={};
   if(create||op==='update')patch=validateWorkspaceInput(req.body,{create});
   if(op==='update'&&(!Number.isSafeInteger(req.body.expectedVersion)||req.body.expectedVersion<1))throw Error('INVALID');
   if(req.params.id&&!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(req.params.id))throw Error('INVALID');
   const {data,error}=await deps.supabaseAdmin.rpc('content_workspace_command',{p_actor:a.user.id,p_can_approve:a.canApprove,p_operation:op,p_id:req.params.id||null,p_version:req.body?.expectedVersion||null,p_patch:patch});
   if(error){const msg=String(error.message||'');if(msg.includes('VERSION_CONFLICT'))return res.status(409).json({error:'Otra persona actualizó esta pieza. Recarga antes de guardar.'});if(msg.includes('FORBIDDEN'))return res.status(403).json({error:'La aprobación corresponde a dirección.'});if(msg.includes('NOT_FOUND'))return res.status(404).json({error:'Pieza inexistente'});if(msg.includes('INVALID'))return res.status(400).json({error:'Completa los datos requeridos para este estado.'});throw error;}
   const result=op==='read'?await enrichWorkspaceHistory(data,deps.supabaseAdmin):data;
   res.status(create?201:200).json({...result,...(op==='read'?{publications:data.item?.publications||[]} : {}),...(op==='list'?{can_approve:a.canApprove,can_manage_coordinators:a.canManageCoordinators,can_decide_promotion:a.canDecidePromotion}:{})});
  }catch(e){res.status(e.message==='INVALID'?400:503).json({error:e.message==='INVALID'?'Revisa los datos de la pieza.':'No se pudo guardar o cargar el contenido.'});}
 }
 router.get('/coordinators',async(req,res)=>{try{if(!req.workspaceAuth.canManageCoordinators)return res.status(403).json({error:'Sin permiso'});const r=await deps.supabaseAdmin.rpc('content_workspace_coordinators_list',{p_actor:req.workspaceAuth.user.id});if(r.error)throw r.error;res.json({coordinators:r.data||[]});}catch{res.status(503).json({error:'No se pudieron cargar los accesos.'});}});
 router.post('/coordinators',async(req,res)=>{try{if(typeof req.body?.email!=='string'||typeof req.body?.active!=='boolean')return res.status(400).json({error:'Revisa el correo y la autorización.'});const r=await deps.supabaseAdmin.rpc('content_workspace_coordinator_grant',{p_actor:req.workspaceAuth.user.id,p_email:req.body.email,p_active:req.body.active});if(r.error)return res.status(r.error.message?.includes('FORBIDDEN')?403:409).json({error:'Solo el dueño puede autorizar una cuenta única y verificada.'});res.json(r.data);}catch{res.status(503).json({error:'No se pudo guardar el acceso.'});}});
 router.post('/:id/promotion',async(req,res)=>{try{if(!req.workspaceAuth.canDecidePromotion)return res.status(403).json({error:'La decisión corresponde a coordinación.'});if(!Number.isSafeInteger(req.body?.expectedVersion)||!['sin_decidir','organico','promocionar','no_promocionar'].includes(req.body?.decision)||typeof req.body?.note!=='string'||req.body.note.length>3000)return res.status(400).json({error:'Revisa la decisión.'});const r=await deps.supabaseAdmin.rpc('content_workspace_command',{p_actor:req.workspaceAuth.user.id,p_can_approve:true,p_operation:'promotion',p_id:req.params.id,p_version:req.body.expectedVersion,p_patch:{decision:req.body.decision,note:req.body.note.trim()}});if(r.error)return res.status(r.error.message?.includes('VERSION_CONFLICT')?409:400).json({error:'Revisa la aprobación y actualiza la pieza antes de guardar.'});res.json(r.data);}catch{res.status(503).json({error:'No se pudo registrar la decisión.'});}});
 router.get('/editors',async(req,res)=>{if(!req.workspaceAuth.canApprove)return res.status(403).json({error:'Sin permiso'});try{const {data,error}=await deps.supabaseAdmin.from('user_roles').select('user_id,email,nombre').eq('role','editor_contenido');if(error)throw error;res.json({editors:(data||[]).filter(x=>x.user_id).map(x=>({id:x.user_id,email:x.email,name:x.nombre||x.email}))});}catch{res.status(503).json({error:'No se pudieron cargar los editores'});}});
 async function scope(req){const a=req.workspaceAuth;const r=await deps.supabaseAdmin.rpc('content_workspace_command',{p_actor:a.user.id,p_can_approve:a.canApprove,p_operation:'read',p_id:req.params.id,p_version:null,p_patch:{}});if(r.error)throw r.error;return r.data;}
 router.post('/:id/files',(req,res)=>upload.single('file')(req,res,async(err)=>{if(err)return res.status(400).json({error:'El archivo supera 50 MB o no es válido.'});try{await scope(req);const f=req.file;if(!f||!validFileSignature(f)||!/^image\/(png|jpeg|webp|gif)$|^video\/(mp4|webm|quicktime)$|^application\/pdf$/.test(f.mimetype))return res.status(400).json({error:'Sube imagen, video o PDF (máximo 50 MB).'});const id=randomUUID(),path=req.params.id+'/'+id;const saved=await deps.supabaseAdmin.storage.from(bucket).upload(path,f.buffer,{contentType:f.mimetype,upsert:false});if(saved.error)throw saved.error;const result=await deps.supabaseAdmin.rpc('content_workspace_file_add',{p_actor:req.workspaceAuth.user.id,p_can_approve:req.workspaceAuth.canApprove,p_item:req.params.id,p_id:id,p_name:f.originalname.slice(0,200),p_mime:f.mimetype,p_size:f.size,p_path:path});if(result.error)throw result.error;res.status(201).json({file:result.data});}catch{res.status(503).json({error:'No se pudo subir la entrega.'});}}));
 router.get('/:id/files/:fileId',async(req,res)=>{try{await scope(req);const {data,error}=await deps.supabaseAdmin.from('content_workspace_files').select('storage_path').eq('id',req.params.fileId).eq('item_id',req.params.id).maybeSingle();if(error||!data)return res.status(404).json({error:'Archivo inexistente'});const signed=await deps.supabaseAdmin.storage.from(bucket).createSignedUrl(data.storage_path,300);if(signed.error)throw signed.error;res.json({url:signed.data.signedUrl});}catch{res.status(403).json({error:'No se pudo abrir el archivo'});}});
 router.post('/:id/publications',async(req,res)=>{try{const patch=validateWorkspaceInput(req.body);if(!Number.isSafeInteger(req.body.expectedVersion))throw Error('INVALID');const r=await deps.supabaseAdmin.rpc('content_workspace_command',{p_actor:req.workspaceAuth.user.id,p_can_approve:req.workspaceAuth.canApprove,p_operation:'publication',p_id:req.params.id,p_version:req.body.expectedVersion,p_patch:patch});if(r.error)return res.status(r.error.message?.includes('VERSION_CONFLICT')?409:400).json({error:'Revisa la aprobación y los datos de publicación.'});res.status(201).json(r.data);}catch{res.status(400).json({error:'Revisa los datos de publicación'});}});
 router.get('/',(q,s)=>invoke(q,s,'list'));router.get('/:id',(q,s)=>invoke(q,s,'read'));router.post('/',(q,s)=>invoke(q,s,'create'));router.patch('/:id',(q,s)=>invoke(q,s,'update'));
 return router;
}
