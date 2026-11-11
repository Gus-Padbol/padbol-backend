import {resolveAuthRoleForUser,requireAuthenticatedUser} from '../lib/authAccess.js';
import {claimError,createFipaClaimStore} from '../lib/fipaRankingClaims.js';
import {loadOfficialFipaSource} from './fipaOfficialRanking.js';
export function mountFipaRankingClaimRoutes(app,{pgPool,getAuthenticatedUser,fetchUserRoleRowForAuthUser,loadSource=loadOfficialFipaSource}){
 const store=createFipaClaimStore(pgPool);
 const run=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{if(!pgPool)throw claimError('Vinculación temporalmente no disponible.',503);await fn(req,res);}catch(e){console.error('[fipa-claim]',e.code||e.status||'error');res.status(e.status||503).json({error:e.status?e.message:'No se pudo completar la vinculación. Intenta nuevamente.'});}};
 async function operator(req,res){const user=await requireAuthenticatedUser(req,res,getAuthenticatedUser);if(!user)return null;const role=await resolveAuthRoleForUser(user,{fetchUserRoleRowForAuthUser});if(role.rol!=='super_admin'&&!await store.operator(user.id)){res.status(403).json({error:'Se requiere habilitación de coordinación FIPA.'});return null;}return user;}
 const withPlayers=async rows=>{const source=await loadSource();return rows.map(r=>({...r,jugador:source.players.find(p=>p.source_key===r.source_key)||null}));};
 app.get('/api/fipa/solicitudes',run(async(req,res)=>{
  const user=await requireAuthenticatedUser(req,res,getAuthenticatedUser);if(!user)return;
  const rows=await store.requests(user.id);res.json({solicitudes:await withPlayers(rows.map(({email,reviewed_by,...r})=>r))});
 }));
 app.post('/api/fipa/solicitudes',run(async(req,res)=>{
  const user=await requireAuthenticatedUser(req,res,getAuthenticatedUser);if(!user)return;
  const source=await loadSource();const player=source.players.find(p=>p.source_key===req.body?.source_key);if(!player)throw claimError('Jugador no encontrado en el ranking oficial.',404);
  const row=await store.request(player,user,req.body?.identidad_confirmada);res.status(201).json({solicitud:(await withPlayers([row]))[0]});
 }));
 app.get('/api/admin/fipa/solicitudes',run(async(req,res)=>{
  if(!await operator(req,res))return;res.json({solicitudes:await withPlayers(await store.requests())});
 }));
 app.post('/api/admin/fipa/solicitudes/:id/resolver',run(async(req,res)=>{
  const user=await operator(req,res);if(!user)return;
  if(req.body?.decision==='approved'){
   const rows=await store.requests();const row=rows.find(r=>r.id===req.params.id);const source=await loadSource();
   if(!row||!source.players.some(p=>p.source_key===row.source_key))throw claimError('El perfil requiere revisión del ranking oficial.',409);
  }
  const row=await store.review(req.params.id,user,req.body?.decision,req.body?.nota);res.json({ok:true,solicitud:row});
 }));
 app.get('/api/admin/fipa/jugadores',run(async(req,res)=>{
  if(!await operator(req,res))return;
  const [source,links,invitations]=await Promise.all([loadSource(),store.links(),store.invitations()]);
  const linked=new Map(links.map(x=>[x.source_key,x.user_id]));const invited=new Set(invitations.filter(x=>new Date(x.expires_at)>new Date()).map(x=>x.source_key));
  const all=source.players.map(p=>({...p,id:p.source_key,user_id:linked.get(p.source_key)||null,estado_vinculacion:linked.has(p.source_key)?'vinculado':invited.has(p.source_key)?'invitado':'no_reclamado',ranking:{puntos:p.puntos,posicion:p.posicion}}));
  const q=String(req.query.q||'').trim().toLocaleLowerCase();const rows=all.filter(p=>(!q||`${p.nombre_completo} ${p.pais}`.toLocaleLowerCase().includes(q))&&(!req.query.estado||req.query.estado===p.estado_vinculacion));
  res.json({jugadores:rows,total:rows.length,resumen:Object.fromEntries(['no_reclamado','invitado','vinculado'].map(k=>[k,all.filter(x=>x.estado_vinculacion===k).length]))});
 }));
 app.post('/api/admin/fipa/jugadores/:id/invitacion',run(async(req,res)=>{
  const user=await operator(req,res);if(!user)return;
  const source=await loadSource();const player=source.players.find(p=>p.source_key===req.params.id);if(!player)throw claimError('Jugador no encontrado en el ranking oficial.',404);
  const inv=await store.prepare(player,user,req.body);res.status(201).json({ok:true,enlace:`https://padbolmatch.com/fipa/reclamar#token=${encodeURIComponent(inv.token)}`,vence_at:inv.expires_at,envio_realizado:false});
 }));
 app.post('/api/fipa/invitaciones/validar',run(async(req,res)=>{
  const inv=await store.validate(req.body?.token);const source=await loadSource();const player=source.players.find(p=>p.source_key===inv.source_key);if(!player)throw claimError('El perfil requiere revisión del coordinador.',409);
  res.json({valida:true,vence_at:inv.expires_at,jugador:{id:player.source_key,nombre_completo:player.nombre_completo,pais:player.pais,continente:player.continente,puntos:player.puntos,posicion:player.posicion}});
 }));
 app.post('/api/fipa/invitaciones/aceptar',run(async(req,res)=>{
  const user=await requireAuthenticatedUser(req,res,getAuthenticatedUser);if(!user)return;
  const inv=await store.validate(req.body?.token);const source=await loadSource();if(!source.players.some(p=>p.source_key===inv.source_key))throw claimError('El perfil requiere revisión del coordinador.',409);
  const id=await store.accept(req.body?.token,user);res.json({ok:true,jugador_fipa_id:id});
 }));
 app.get('/api/fipa/mi-perfil',run(async(req,res)=>{
  const user=await requireAuthenticatedUser(req,res,getAuthenticatedUser);if(!user)return;
  const [source,links]=await Promise.all([loadSource(),store.links()]);const link=links.find(x=>x.user_id===user.id);const player=source.players.find(x=>x.source_key===link?.source_key);res.json({jugador:player?{...player,user_id:user.id}:null});
 }));
 return store;
}
