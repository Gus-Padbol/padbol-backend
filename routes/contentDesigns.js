import express from 'express';
import {requireAdminUser} from '../lib/authAccess.js';
import {normalizeDesignDocument,designUuid} from '../lib/contentDesignSchema038.js';
const scopeId=value=>{const raw=String(value??'');return /^[1-9]\d*$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):null;};
export function createContentDesignsRouter(deps){
 const router=express.Router();const fail=(res,status,error,code)=>res.status(status).json({error,code});
 const authDeps={getAuthenticatedUser:deps.getAuthenticatedUser,fetchUserRoleRowForAuthUser:deps.fetchUserRoleRowForAuthUser,legacySuperAdminEmails:[]};
 const handle=action=>async(req,res)=>{
  try{
   if(process.env.CONTENT_PRIVATE_DESIGNS_ENABLED!=='true')return fail(res,503,'Mis diseños todavía no está habilitado.','CONTENT_DESIGNS_DISABLED');
   const auth=await requireAdminUser(req,res,authDeps);if(!auth)return;
   if(!['super_admin','admin_club'].includes(auth.role.rol))return fail(res,403,'No tenés permiso para estos diseños.','CONTENT_DESIGN_FORBIDDEN');
   const body=req.body||{};
   if(auth.role.rol==='admin_club'&&[req.query.sede_id,body.sede_id].some(value=>value!=null&&scopeId(value)!==Number(auth.role.sede_id)))return fail(res,403,'No tenés permiso para esta sede.','CONTENT_DESIGN_FORBIDDEN');
   if(req.query.sede_id!=null&&body.sede_id!=null&&scopeId(req.query.sede_id)!==scopeId(body.sede_id))return fail(res,400,'La sede del intento no coincide.','CONTENT_DESIGN_SCOPE_REQUIRED');
   const raw=action==='save'?body.sede_id:req.query.sede_id;
   const sede=scopeId(raw??(auth.role.rol==='admin_club'?auth.role.sede_id:null));
   if(!sede)return fail(res,400,'Elegí una sede válida.','CONTENT_DESIGN_SCOPE_REQUIRED');
   if(auth.role.rol==='admin_club'&&sede!==Number(auth.role.sede_id))return fail(res,403,'No tenés permiso para esta sede.','CONTENT_DESIGN_FORBIDDEN');
   let id=req.params.id||null,expected=null,document=null,key=null;
   if(action!=='list'&&action!=='save'&&!designUuid(id))return fail(res,404,'Diseño inexistente.','CONTENT_DESIGN_NOT_FOUND');
   if(action==='save'){
    if(Object.keys(body).some(k=>!['sede_id','operation_key','project'].includes(k))||!body.project||Object.keys(body.project).some(k=>!['id','expectedVersion','document'].includes(k))||!designUuid(body.project.id)||!designUuid(body.operation_key)||!Number.isSafeInteger(body.project.expectedVersion)||body.project.expectedVersion<0||(req.method==='POST'?body.project.expectedVersion!==0:body.project.expectedVersion<1)||(id&&id!==body.project.id))return fail(res,400,'Revisá el diseño, la versión y el intento.','CONTENT_DESIGN_INVALID');
    id=body.project.id;expected=body.project.expectedVersion;key=body.operation_key;document=normalizeDesignDocument(body.project.document);
   }
   if(!deps.pgPool?.query)return fail(res,503,'No se pudo abrir Mis diseños.','CONTENT_DESIGN_UNAVAILABLE');
   const result=await deps.pgPool.query('SELECT public.content_design_command038($1::uuid,$2::bigint,$3::text,$4::uuid,$5::bigint,$6::jsonb,$7::uuid) result',[auth.user.id,sede,action,id,expected,document,key]);
   if(!result.rows[0]?.result||typeof result.rows[0].result!=='object')throw Error('Missing receipt');
   return res.json(result.rows[0].result);
  }catch(error){
   const code=String(error.message||'');if(error.status===400)return fail(res,400,error.message,error.code);
   if(code.includes('CONTENT_DESIGN_FORBIDDEN'))return fail(res,403,'No tenés permiso para estos diseños.','CONTENT_DESIGN_FORBIDDEN');
   if(code.includes('CONTENT_DESIGN_NOT_FOUND'))return fail(res,404,'Diseño inexistente.','CONTENT_DESIGN_NOT_FOUND');
   if(code.includes('CONTENT_DESIGN_BASE_UNAVAILABLE'))return fail(res,409,'La pieza de base cambió o ya no está habilitada para esta sede.','CONTENT_DESIGN_BASE_UNAVAILABLE');
   if(code.includes('CONTENT_DESIGN_VERSION_CONFLICT')||error.code==='23505')return fail(res,409,'El diseño cambió. Volvé a abrirlo antes de guardar.','CONTENT_DESIGN_VERSION_CONFLICT');
   if(code.includes('CONTENT_DESIGN_IDEMPOTENCY_CONFLICT'))return fail(res,409,'El intento ya fue utilizado con otro contenido.','CONTENT_DESIGN_IDEMPOTENCY_CONFLICT');
   if(code.includes('CONTENT_DESIGN_INVALID')||['22P02','22003'].includes(error.code))return fail(res,400,'Revisá el diseño y sus capas.','CONTENT_DESIGN_INVALID');
   return fail(res,503,'No se pudo confirmar el diseño. Conservá el intento antes de reintentar.','CONTENT_DESIGN_UNAVAILABLE');
  }
 };
 router.get('/',handle('list'));router.get('/:id',handle('read'));router.post('/',handle('save'));router.put('/:id',handle('save'));return router;
}
