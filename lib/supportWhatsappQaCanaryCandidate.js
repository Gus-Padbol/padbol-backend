import {assertStagingIsolation} from './backendRuntime.js';
import {createSupportWhatsappDispatcherCandidate,createSupportWhatsappTransport} from './supportWhatsappDispatcherCandidate.js';
const QA=Object.freeze({project:'vxikhdulhuvghfqeutnp',service:'srv-dahbs0dbedkc73a0kf4g',url:'https://padbol-backend-qa.onrender.com',tenant:'3a2e5306-e1fc-4b24-b03b-fe965fc37e97',channel:'81bba438-eb65-4f70-bdf9-32f6c113d5bf',organization:'067d7269-27e3-4aaf-9da4-c80ba56e1d2a',phone:'1376102838911694',waba:'928900479733370',graphVersion:'v26.0'});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createSupportWhatsappQaCanaryCandidate({env=process.env,pool,fetchImpl=globalThis.fetch,dispatcherFactory=createSupportWhatsappDispatcherCandidate}={}){
 if(env.CRM_SUPPORT_QA_CANARY_ENABLED!=='true')return null;
 assertStagingIsolation(env);
 const effectId=Number(env.CRM_SUPPORT_QA_CANARY_EFFECT_ID),recipient=env.CRM_SUPPORT_QA_CANARY_AUTHORIZED_RECIPIENT||'',principalId=env.CRM_SUPPORT_QA_CANARY_PRINCIPAL_ID;
 if(env.CRM_SUPPORT_QA_CANARY_SECURITY_APPROVED!=='true'||env.BACKEND_RUNTIME_MODE!=='staging'||env.STAGING_SUPABASE_PROJECT_REF!==QA.project||env.SUPABASE_URL!==`https://${QA.project}.supabase.co`||env.RENDER_SERVICE_ID!==QA.service||env.RENDER_EXTERNAL_URL!==QA.url||env.WHATSAPP_META_GRAPH_VERSION!==QA.graphVersion||env.OUTBOUND_DELIVERY_ENABLED!=='false'||env.BACKGROUND_JOBS_ENABLED!=='false'||env.PUSH_SEND_ENABLED!=='false'||env.WHATSAPP_CLOUD_SEND_ENABLED!=='true'||env.WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS!=='1'||env.CRM_SUPPORT_WHATSAPP_SEND_ENABLED==='true'||!UUID.test(principalId||'')||!Number.isSafeInteger(effectId)||effectId<1||!/^[1-9][0-9]{7,14}$/.test(recipient)||!env.WHATSAPP_META_TOKEN_TEST?.trim()||!pool?.connect||typeof fetchImpl!=='function')throw Error('SUPPORT_QA_CANARY_CONFIG_INVALID');
 const sender=createSupportWhatsappTransport({graphVersion:QA.graphVersion,resolveAccessToken:channel=>channel?.id===QA.channel&&channel.meta_phone_number_id===QA.phone&&channel.credential_ref==='TEST'?env.WHATSAPP_META_TOKEN_TEST.trim():null,
  fetchImpl:(url,options)=>{
   const body=JSON.parse(options.body||'{}');
   if(url!==`https://graph.facebook.com/${QA.graphVersion}/${QA.phone}/messages`||options.method!=='POST'||options.redirect!=='error'||body.to!==recipient||body.type!=='text')throw Error('SUPPORT_QA_CANARY_TRANSPORT_SCOPE');
   return fetchImpl(url,options);
  }});
 const guardedSender={async sendText(request){if(request.toWaId!==recipient||request.channel?.id!==QA.channel||request.channel?.credential_ref!=='TEST'||request.channel?.meta_phone_number_id!==QA.phone)throw Error('SUPPORT_QA_CANARY_RECIPIENT_DENIED');return sender.sendText(request)}};
 const dispatcher=dispatcherFactory({pool,sender:guardedSender,principalId,enabled:true});
 let invoked=false;
 return Object.freeze({async runOnce(){
  if(invoked)return{status:'held',sent:false,retryAllowed:false};invoked=true;
  const c=await pool.connect();let permit;
  try{permit=(await c.query('select public.crm_support_reserve_qa_canary($1,$2,$3) result',[effectId,principalId,recipient])).rows[0]?.result}finally{c.release()}
  if(permit?.reserved!==true)return{status:'held',sent:false,retryAllowed:false};
  return dispatcher.dispatch(effectId);
 }});
}
