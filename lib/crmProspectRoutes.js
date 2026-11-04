import { createProspectApi } from './crmProspectApi.js';

const statusFor = error => [400,401,403,404,409,503].includes(error?.status) ? error.status : 503;

export function registerProspectRoutes(app,{db,authUserFromBearer,resolveTrustedSuperadmin,logger=console}={}) {
  if(!db||typeof authUserFromBearer!=='function'||typeof resolveTrustedSuperadmin!=='function') return null;
  const api=createProspectApi({db,resolveTrustedSuperadmin});
  const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{const user=await authUserFromBearer(req);return res.json(await fn(user,req));}catch(e){logger?.error?.('[prospect]',{code:e?.code||'UNAVAILABLE'});return res.status(statusFor(e)).json({error:e?.message||'No disponible.',code:e?.code||'PROSPECT_UNAVAILABLE'});}};
  app.get('/api/admin/crm/prospect/status',handle(u=>api.status(u)));
  app.get('/api/admin/crm/prospect/prospects',handle((u,r)=>api.list(u,r.query)));
  app.post('/api/admin/crm/prospect/prospects/search',handle((u,r)=>api.search(u,r.body)));
  app.get('/api/admin/crm/prospect/prospects/:id',handle((u,r)=>api.read(u,r.params.id)));
  app.patch('/api/admin/crm/prospect/prospects/:id',handle((u,r)=>api.update(u,r.params.id,r.body)));
  app.post('/api/admin/crm/prospect/prospects/:id/response',handle((u,r)=>api.response(u,r.params.id,r.body)));
  app.get('/api/admin/crm/prospect/dashboard',handle(u=>api.dashboard(u)));
  app.get('/api/admin/crm/prospect/campaigns',handle(u=>api.campaigns(u)));
  app.post('/api/admin/crm/prospect/campaigns',handle((u,r)=>api.createCampaign(u,r.body)));
  app.patch('/api/admin/crm/prospect/campaigns/:id',handle((u,r)=>api.updateCampaign(u,r.params.id,r.body)));
  app.get('/api/admin/crm/prospect/campaigns/:id/messages',handle((u,r)=>api.campaignMessages(u,r.params.id)));
  app.post('/api/admin/crm/prospect/campaigns/:id/simulate',handle((u,r)=>api.simulate(u,r.params.id)));
  app.post('/api/admin/crm/prospect/campaigns/:id/simulate-followup',handle((u,r)=>api.simulateFollowup(u,r.params.id,r.body)));
  app.get('/api/admin/crm/prospect/suppressions',handle(u=>api.suppressions(u)));
  app.post('/api/admin/crm/prospect/suppressions',handle((u,r)=>api.addSuppression(u,r.body)));
  return api;
}
