import {createNationsActivationService,activationError} from '../lib/nationsActivation.js';
import {createNationsProfileRequestsService} from '../lib/nationsProfileRequests.js';
const NAPLES_SLUG = 'nations-cup-napoli-2026';
const NAPLES_IP_LIMIT = 120;
const NAPLES_ACTOR_LIMIT = 5;

export function registerNationsActivationRoutes(app,{pool,authUserFromBearer,profileRequestsDep=null,service=pool?createNationsActivationService({pool}):null,now=()=>Date.now(),logger=console}={}){
 const profileRequests=profileRequestsDep||createNationsProfileRequestsService({pool});
 const buckets=new Map();
 function limit(req,action,max,actorKey=null){const key=actorKey?`${action}:${actorKey}`:`${action}:${String(req.ip||req.socket?.remoteAddress||'unknown')}`;const t=now(),old=buckets.get(key);if(!old&&buckets.size>=10000){for(const [k,v]of buckets)if(v.until<t)buckets.delete(k);if(buckets.size>=10000)throw activationError('RATE_LIMITED',429);}if(!old||old.until<t)buckets.set(key,{count:1,until:t+60000});else if(++old.count>max)throw activationError('RATE_LIMITED',429);}
 const run=(action,fn,max=30,options={})=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{if(!service)throw activationError('NOT_READY',503);if(!/^[a-z0-9][a-z0-9-]{2,79}$/.test(req.params.slug||''))throw activationError('EVENT_NOT_AVAILABLE',404);if(options.actorScoped&&req.params.slug===NAPLES_SLUG){limit(req,`${action}_ip`,options.ipMax??NAPLES_IP_LIMIT);const actor=await user(req);limit(req,`${action}_actor`,options.actorMax??NAPLES_ACTOR_LIMIT,actor.id);return res.json(await fn(req,actor));}limit(req,action,max);return res.json(await fn(req));}catch(e){const status=[400,401,403,404,409,429,503].includes(e.status)?e.status:503;logger?.error?.('[nations-activation]',{code:e.code||'UNAVAILABLE'});return res.status(status).json({error:e.code||'UNAVAILABLE',code:e.code||'UNAVAILABLE'});}};
 const user=async req=>{const u=await authUserFromBearer(req);if(!u?.id||!u.email_confirmed_at)throw activationError('VERIFIED_ACCOUNT_REQUIRED',401);return u;};
 const pub='/api/nations-activation/events/:slug',admin='/api/admin/nations-activation/events/:slug';
 app.get(admin+'/access',run('access',async r=>service.access(await user(r)),30));
 app.post(admin+'/configure',run('configure',async r=>service.configure(r.params.slug,await user(r),r.body||{}),5));
 app.post(admin+'/delegates',run('delegate',async r=>service.delegate(r.params.slug,await user(r),r.body||{}),10));
 app.post(admin+'/participants/:participantId/guardian-review',run('guardian',async r=>service.guardianReview(r.params.slug,await user(r),r.params.participantId,r.body||{}),10));
 app.get(pub,run('event',r=>service.publicEvent(r.params.slug),60));
 app.get(pub+'/me',run('me',async r=>service.me(r.params.slug,await user(r)),60));
 app.get(pub+'/players',run('lookup',r=>service.players(r.params.slug,r.query),20));
 app.post(pub+'/profile-request',run('profile_request',async(r,actor)=>profileRequests.submit(r.params.slug,actor||await user(r),r.body||{}),10,{actorScoped:true,ipMax:120,actorMax:5}));
 app.get(pub+'/profile-request',run('profile_request_status',async(r,actor)=>profileRequests.ownStatus(r.params.slug,actor||await user(r)),20,{actorScoped:true,ipMax:120,actorMax:20}));
 app.get(admin+'/profile-requests',run('profile_request_list',async r=>profileRequests.pending(r.params.slug,await user(r)),20));
 app.post(admin+'/profile-requests/:requestId/review',run('profile_request_review',async r=>profileRequests.review(r.params.slug,await user(r),r.params.requestId,r.body||{}),10));
 // Metadatos publicos minimos torneo -> evento (slug). No revela nomina ni identidades.
 app.get('/api/nations-activation/by-torneo/:torneoId', async (req,res)=>{
   res.setHeader('Cache-Control','no-store');
   try{
     const id=Number(req.params.torneoId);
     if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'INVALID_TORNEO',code:'INVALID_TORNEO'});
     const {rows}=await pool.query(
       `select e.slug from public.nations_activation_events e
          join public.torneos t on t.id=e.torneo_id
         where e.torneo_id=$1 and e.enabled=true and t.modalidad_plantel='selecciones' limit 1`,[id]);
     return res.json({ok:true, slug: rows[0]?.slug||null});
   }catch(e){logger?.error?.('[nations-activation]',{code:'BY_TORNEO_FAILED'});return res.status(503).json({error:'UNAVAILABLE',code:'UNAVAILABLE'});}
 });
 app.post(pub+'/claim',run('claim',async r=>service.claim(r.params.slug,await user(r),r.body||{}),10));
 app.get(admin,run('overview',async r=>service.overview(r.params.slug,await user(r)),60));
 app.post(admin+'/imports/preview',run('preview',async r=>service.preview(r.params.slug,await user(r),r.body?.rows),10));
 app.post(admin+'/imports/confirm',run('confirm',async r=>service.confirm(r.params.slug,await user(r),r.body||{}),10));
 app.post(admin+'/participants/:participantId/invitation',run('issue',async r=>service.invitation(r.params.slug,await user(r),r.params.participantId,r.body||{}),10));
 app.post(admin+'/participants/:participantId/revoke',run('revoke',async r=>service.revoke(r.params.slug,await user(r),r.params.participantId),10));
 return service;
}
