import express from 'express';
import { registerClubCustomerImportRoutes } from './clubCustomerImportRoutes.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const denied=()=>Object.assign(new Error('Sede no autorizada.'),{status:403});
// Only these two POST endpoints receive the larger parser; all other bodies retain 100 KB.
export function createClubCustomerImportBodyGate(){
 const parser=express.json({limit:'4mb'});
 return(req,res,next)=>{
  if(req.method!=='POST'||!/^\/api\/admin\/sedes\/[^/]+\/importaciones\/clientes\/(preview|confirm)\/?$/.test(req.path))return next();
  parser(req,res,error=>error?.type==='entity.too.large'?res.status(413).json({error:'El archivo supera el máximo permitido.',code:'CUSTOMER_IMPORT_TOO_LARGE'}):error?next(error):next());
 };
}
export async function authorizeClubCustomerImport(db,{actorId,venueId,lock=false}){
 if(typeof actorId!=='string'||!UUID.test(actorId)||!Number.isSafeInteger(venueId)||venueId<=0)throw denied();
 const roles=await db.query(`SELECT id,role,sede_id,alcance FROM public.user_roles WHERE user_id=$1 ORDER BY id${lock?' FOR SHARE':''}`,[actorId]);
 if(roles.rows.length!==1)throw denied();
 const row=roles.rows[0];
 if(row.role!=='super_admin'&&(row.role!=='admin_club'||Number(row.sede_id)!==venueId||row.alcance!=='sede'))throw denied();
 const venue=await db.query(`SELECT id FROM public.sedes WHERE id=$1${lock?' FOR SHARE':''}`,[venueId]);
 if(venue.rows.length!==1)throw denied();
 return{authUserId:actorId,rol:row.role,sedeId:venueId};
}
async function authorizeReadDecision(pool,scope){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SET LOCAL statement_timeout = '15s'");
  await db.query("SET LOCAL lock_timeout = '3s'");
  await authorizeClubCustomerImport(db,{actorId:scope.actorId,venueId:scope.venueId,lock:true});
  // COMMIT is the authorization decision: a competing role/venue revoke waits
  // until this short read transaction ends. No Auth/network work under locks.
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}
 finally{db.release();}
}
export function mountClubCustomerImport(app,{pool,getAuthenticatedUser,enabled=false}){
 // OFF performs no Auth/SDK/DB calls, including malformed user input.
 const path='/api/admin/sedes/:sedeId/importaciones/clientes';
 app.use(path,(req,res,next)=>enabled?next():res.status(409).set('Cache-Control','no-store').json({error:'Importación todavía no habilitada en este entorno.'}));
 const resolveScope=async req=>{
  const auth=await getAuthenticatedUser(req);
  if(!auth?.user?.id)throw Object.assign(new Error('Ingresá con tu cuenta.'),{status:401});
  if(!pool)throw Object.assign(new Error('Importación todavía no habilitada en este entorno.'),{status:409});
  return authorizeClubCustomerImport(pool,{actorId:auth.user.id,venueId:Number(req.params.sedeId)});
 };
 registerClubCustomerImportRoutes(app,{pool,enabled,resolveScope,allowedVenues:async scope=>({sedes:[{id:scope.sedeId}]}),
  authorizeTransaction:(db,scope)=>authorizeClubCustomerImport(db,{actorId:scope.actorId,venueId:scope.venueId,lock:true}),
  revalidateScope:(req,scope)=>authorizeReadDecision(pool,scope)});
}
