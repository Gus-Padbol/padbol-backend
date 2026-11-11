export function registerCrmLeadNotificationRoutes(app,{authUserFromBearer,notifications}={}) {
  if(!notifications||typeof authUserFromBearer!=='function')return null;
  const auth=async(req,res)=>{const user=await authUserFromBearer(req);if(!user?.id){res.status(401).json({error:'No autorizado'});return null;}return user;};
  app.get('/api/admin/crm/lead-notifications',async(req,res)=>{const user=await auth(req,res);if(!user)return;try{res.set('Cache-Control','no-store');res.json(await notifications.list(user.id));}catch(e){res.status(503).json({error:'No se pudieron leer las notificaciones.'});}});
  app.post('/api/admin/crm/lead-notifications/:id/read',async(req,res)=>{const user=await auth(req,res);if(!user)return;try{res.json(await notifications.markRead(user.id,req.params.id));}catch(e){res.status(e.status||400).json({error:e.message||'No se pudo marcar.'});}});
  app.post('/api/admin/crm/lead-notifications/replay/:conversationId',async(req,res)=>{const user=await auth(req,res);if(!user)return;try{res.json(await notifications.notifyExisting(req.params.conversationId,req.body?.caseType||'form'));}catch(e){res.status(e.status||400).json({error:e.message||'No se pudo generar el aviso.'});}});
  app.post('/api/admin/crm/lead-notifications/test',async(req,res)=>{const user=await auth(req,res);if(!user)return;try{res.json(await notifications.notifyTest(user.id));}catch(e){res.status(e.status||503).json({error:e.message||'No se pudo enviar la prueba.'});}});
  return notifications;
}
