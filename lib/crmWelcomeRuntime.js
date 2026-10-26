import {verifyWelcomeTemplates} from './crmWelcomeConfig.js';
import {createWelcomeRepositoryCandidate} from './crmWelcomeRepositoryCandidate.js';
import {createWelcomePgLockStoreCandidate} from './crmWelcomeSerializedCandidate.js';
import {createWelcomeMetaTransport} from './crmWelcomeMetaTransportCandidate.js';
import {startWelcomeWorkerCandidate} from './crmWelcomeWorkerCandidate.js';

// Existing persisted CRM submissions are the durable queue. The scanner never
// sends from browser input or before CRM has committed the conversation.
export async function initializeCrmWelcome({db,pool,env=process.env,runtime,logger=console,fetchImpl=globalThis.fetch,verify=verifyWelcomeTemplates,start=startWelcomeWorkerCandidate}={}) {
 const disabled={started:false,reason:'disabled',stop(){}};
 if(env.CRM_FORM_WHATSAPP_WELCOME_ENABLED!=='true')return disabled;
 if(runtime?.mode!=='production'||!runtime?.outboundDeliveryEnabled||!db||!pool||env.WHATSAPP_COMMERCIAL_CHIVI_WAIT_ENABLED!=='true')return {...disabled,reason:'runtime_not_ready'};
 // Initial delivery may offer Chivi only after the verified inbound association
 // is deployed and checked. This gate is deliberately separate from its AI flag.
 if(env.CRM_WELCOME_INBOUND_READY!=='true')return {...disabled,reason:'inbound_association_not_verified'};
 const since=env.CRM_WELCOME_ACTIVATED_AT;
 if(!since || !Number.isFinite(Date.parse(since)))return {...disabled,reason:'activation_time_required'};
 const version=env.WHATSAPP_META_GRAPH_VERSION;
 const accessToken=env.CRM_WHATSAPP_ACCESS_TOKEN;
 const templates={es:{name:env.CRM_WELCOME_TEMPLATE_ES,locale:env.CRM_WELCOME_TEMPLATE_ES_LOCALE||'es'},en:{name:env.CRM_WELCOME_TEMPLATE_EN,locale:env.CRM_WELCOME_TEMPLATE_EN_LOCALE||'en_US'}};
 const approval=await verify({enabled:true,chiviReady:true,phoneId:env.CRM_WELCOME_PHONE_ID,wabaId:env.CRM_WELCOME_WABA_ID,version,accessToken,templates,fetchImpl});
 if(!approval.ready){logger?.warn?.('[crm-welcome] not ready',{reason:approval.reason});return {...disabled,reason:approval.reason};}
 // Schema validation is read-only; migrations are applied separately.
 try {await db.rpc('crm_list_welcome_pending_candidate',{p_limit:1,p_since:since}).then(({error})=>{if(error)throw Error('schema_missing')});}
 catch {logger?.warn?.('[crm-welcome] schema unavailable');return {...disabled,reason:'schema_missing'};}
 const transport=createWelcomeMetaTransport({enabled:true,phoneId:env.CRM_WELCOME_PHONE_ID,version,accessToken,approvedTemplates:Object.values(approval.templates),fetchImpl});
 return start({enabled:true,repository:createWelcomeRepositoryCandidate(db,{since}),lockStore:createWelcomePgLockStoreCandidate(pool),transport,templates:approval.templates,logger,intervalMs:15000});
}
