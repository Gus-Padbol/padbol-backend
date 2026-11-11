import { createProspectApi } from './crmProspectApi.js';
import { verifyUnsubscribeToken } from './crmProspectSequence.js';

const statusFor = error => [400,401,403,404,409,503].includes(error?.status) ? error.status : 503;

export function registerProspectRoutes(app,{db,pool=null,authUserFromBearer,resolveTrustedSuperadmin,logger=console}={}) {
  if(!db||typeof authUserFromBearer!=='function'||typeof resolveTrustedSuperadmin!=='function') return null;
  const api=createProspectApi({db,pool,resolveTrustedSuperadmin});
  const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{const user=await authUserFromBearer(req);return res.json(await fn(user,req));}catch(e){logger?.error?.('[prospect]',{code:e?.code||'UNAVAILABLE'});return res.status(statusFor(e)).json({error:e?.message||'No disponible.',code:e?.code||'PROSPECT_UNAVAILABLE'});}};
  app.get('/api/prospect/unsubscribe', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const value = verifyUnsubscribeToken(req.query?.token);
    if (!value) return res.status(400).type('html').send('<h1>Enlace de baja inválido</h1><p>El enlace expiró o no es válido.</p>');
    try {
      await db.from('crm_prospect_suppressions').insert({ email: value.email, reason: 'opt_out', source: 'unsubscribe-link', created_by: 'public-unsubscribe' });
      await db.from('crm_prospects').update({ status: 'opt_out' }).ilike('email', value.email);
      const { data: prospects } = await db.from('crm_prospects').select('id').ilike('email', value.email);
      const ids = (prospects || []).map(item => item.id);
      if (ids.length) await db.from('crm_prospect_messages').update({ status: 'cancelled' }).in('prospect_id', ids).in('status', ['simulated', 'queued']);
      return res.status(200).type('html').send('<h1>Baja registrada</h1><p>No recibirá más comunicaciones comerciales de Padbol.</p>');
    } catch (error) {
      logger?.error?.('[prospect-unsubscribe]', { code: error?.code || 'UNAVAILABLE' });
      return res.status(503).type('html').send('<h1>No pudimos procesar la baja</h1><p>Escriba a info@padbol.com.</p>');
    }
  });

  app.get('/api/admin/crm/prospect/status',handle(u=>api.status(u)));
  app.get('/api/admin/crm/prospect/prospects',handle((u,r)=>api.list(u,r.query)));
  app.post('/api/admin/crm/prospect/prospects/search',handle((u,r)=>api.search(u,r.body)));
  app.get('/api/admin/crm/prospect/prospects/:id',handle((u,r)=>api.read(u,r.params.id)));
  app.patch('/api/admin/crm/prospect/prospects/:id',handle((u,r)=>api.update(u,r.params.id,r.body)));
  app.post('/api/admin/crm/prospect/prospects/:id/response',handle((u,r)=>api.response(u,r.params.id,r.body)));
  app.get('/api/admin/crm/prospect/dashboard',handle(u=>api.dashboard(u)));
  app.get('/api/admin/crm/prospect/campaigns',handle(u=>api.campaigns(u)));
  app.post('/api/admin/crm/prospect/run-due',handle(u=>api.runDue(u)));
  app.get('/api/admin/crm/prospect/territories',handle(u=>api.territories(u)));
  app.post('/api/admin/crm/prospect/territories',handle((u,r)=>api.saveTerritory(u,r.body)));
  app.post('/api/admin/crm/prospect/campaigns',handle((u,r)=>api.createCampaign(u,r.body)));
  app.patch('/api/admin/crm/prospect/campaigns/:id',handle((u,r)=>api.updateCampaign(u,r.params.id,r.body)));
  app.get('/api/admin/crm/prospect/campaigns/:id/messages',handle((u,r)=>api.campaignMessages(u,r.params.id)));
  app.post('/api/admin/crm/prospect/campaigns/:id/simulate',handle((u,r)=>api.simulate(u,r.params.id)));
  app.post('/api/admin/crm/prospect/campaigns/:id/simulate-followup',handle((u,r)=>api.simulateFollowup(u,r.params.id,r.body)));
  app.get('/api/admin/crm/prospect/suppressions',handle(u=>api.suppressions(u)));
  app.post('/api/admin/crm/prospect/suppressions',handle((u,r)=>api.addSuppression(u,r.body)));
  return api;
}
