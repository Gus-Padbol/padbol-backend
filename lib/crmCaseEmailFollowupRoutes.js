export function registerCaseEmailFollowupRoutes(app,{api,authUserFromBearer,logger=console}={}){
 if(!api||typeof authUserFromBearer!=='function')throw Error('CASE_EMAIL_ROUTES_CONFIG_INVALID');
 const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{const user=await authUserFromBearer(req);if(!user)throw Object.assign(Error('UNAUTHENTICATED'),{status:401,code:'UNAUTHENTICATED'});return res.json(await fn(user,req));}catch(e){const status=[400,401,403,404,409,503].includes(e?.status)?e.status:503;logger?.error?.('[case-email]',{code:e?.code||'UNAVAILABLE'});return res.status(status).json({error:e?.code||'UNAVAILABLE'});}};
 app.get('/api/admin/crm/commercial-cases/:id/case-email-followup',handle((u,r)=>api.caseEmailStatus(u,r.query.channel,r.params.id)));
 app.post('/api/admin/crm/commercial-cases/:id/case-email-followup',handle((u,r)=>api.caseEmailActivate(u,r.body?.channel,r.params.id,r.body?.language,r.body?.consentEvidence)));
 if(typeof app.delete==='function')app.delete('/api/admin/crm/commercial-cases/:id/case-email-followup',handle((u,r)=>api.caseEmailCancel(u,r.query.channel,r.params.id,r.query.reason)));
}
