import {productionMenuTokenResolver} from './whatsappProductionTokenCandidate.js';
import {createSupportWhatsappDispatcherCandidate,createSupportWhatsappTransport} from './supportWhatsappDispatcherCandidate.js';
const CHANNEL='1bad838f-b5cc-4ae4-b28d-e63c998c6474';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function mountSupportWhatsappDeliveryCandidate({env=process.env,runtime,pool,cron,serviceRoleConfigured,
 dispatcherFactory=createSupportWhatsappDispatcherCandidate,transportFactory=createSupportWhatsappTransport,logger=console}={}){
 if(env.CRM_SUPPORT_WHATSAPP_SEND_ENABLED!=='true')return null;
 // QA's existing exception is MANUAL only, with global outbound/jobs disabled.
 // Do not borrow its captured fetch, owner identity, or security approval.
 if(runtime?.mode!=='production')throw Error('SUPPORT_DELIVERY_RUNTIME_NOT_AUTHORIZED');
 if(env.CRM_SUPPORT_WHATSAPP_SECURITY_APPROVED!=='true'||!runtime.outboundDeliveryEnabled||!runtime.backgroundJobsEnabled||!serviceRoleConfigured||!pool?.connect||!cron?.schedule||env.WHATSAPP_PRODUCTION_MENU_ENABLED!=='true'||env.WHATSAPP_PRODUCTION_MENU_CHANNEL_ID!==CHANNEL||!UUID.test(env.CRM_SUPPORT_DELIVERY_PRINCIPAL_ID||'')||!/^v[0-9]{1,3}\.0$/.test(env.WHATSAPP_META_GRAPH_VERSION||''))throw Error('SUPPORT_DELIVERY_STARTUP_INVALID');
 const resolver=productionMenuTokenResolver(env);
 if(!resolver({id:CHANNEL,meta_phone_number_id:'1376102838911694',credential_ref:'PRODUCTION'}))throw Error('SUPPORT_DELIVERY_TOKEN_SCOPE_INVALID');
 const sender=transportFactory({graphVersion:env.WHATSAPP_META_GRAPH_VERSION,resolveAccessToken:resolver});
 const dispatcher=dispatcherFactory({pool,sender,principalId:env.CRM_SUPPORT_DELIVERY_PRINCIPAL_ID,enabled:true});
 let running=false;
 const task=cron.schedule('* * * * *',async()=>{
  if(running)return;running=true;
  try{await dispatcher.sweep(10)}catch{logger.warn('[support-whatsapp] guarded sweep unavailable')}finally{running=false}
 });
 return Object.freeze({dispatcher,stop:()=>task?.stop?.()});
}
