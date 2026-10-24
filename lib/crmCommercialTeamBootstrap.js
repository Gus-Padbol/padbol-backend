import pg from 'pg';
import {createCommercialTeamApi,registerCommercialTeamRoutes} from './crmCommercialTeamApi.js';
import {createCommercialTeamSender} from './crmCommercialTeamSender.js';
import {createCommercialTeamFormSender} from './crmCommercialTeamFormSender.js';
import {createCommercialTeamMedia} from './crmCommercialTeamMedia.js';
import {createWhatsappMediaRepository,createWhatsappMediaAccess} from './whatsappMediaAccess.js';
// One owner only: the caller replaces the old bootstrap, not invokes both.
// These gates are NOT evidence; they must be set only after verified readiness.
export function initializeCommercialRollout({app,db,authUserFromBearer,resolveTrustedSuperadmin,manualWhatsappSender,emailSender,legacyBootstrap,env=process.env,poolFactory,fetchImpl}={}) {
 if(env.CRM_COMMERCIAL_TEAM_ENABLED!=='true')return legacyBootstrap({app,db,authUserFromBearer,manualSender:manualWhatsappSender,env,poolFactory});
 // Preserve the existing owner when a team gate is missing; do not mount
 // either half of a new commercial surface.
 if(env.CRM_COMMERCIAL_CASES_ENABLED!=='true'||env.CRM_COMMERCIAL_CASES_RECOVERY_VERIFIED!=='true'||env.CRM_COMMERCIAL_TEAM_VERIFIED!=='true')return legacyBootstrap({app,db,authUserFromBearer,manualSender:manualWhatsappSender,env,poolFactory});
 if(!env.CRM_COMMERCIAL_CASES_DATABASE_URL||!db?.rpc||typeof authUserFromBearer!=='function'||typeof resolveTrustedSuperadmin!=='function'||typeof manualWhatsappSender!=='function'||typeof emailSender!=='function')throw Error('COMMERCIAL_TEAM_BOOTSTRAP_INVALID');
 const pool=poolFactory?poolFactory(env.CRM_COMMERCIAL_CASES_DATABASE_URL):new pg.Pool({connectionString:env.CRM_COMMERCIAL_CASES_DATABASE_URL,max:2});
 const repository=createWhatsappMediaRepository({supabaseAdmin:db,channelId:env.CRM_WHATSAPP_CHANNEL_ID,phoneNumberId:env.CRM_WHATSAPP_PHONE_NUMBER_ID});
 const mediaAccess=createWhatsappMediaAccess({repository,env,fetchImpl:fetchImpl||globalThis.fetch,authorizeConversation:async()=>{}});
 const retrieveMemberMedia=createCommercialTeamMedia({guard:async({actorId,superadmin,caseId,eventId})=>{const r=await db.rpc('crm_commercial_team_media_member',{p_actor:actorId,p_superadmin:superadmin,p_case:caseId,p_event:eventId});if(r.error)throw Object.assign(Error('UNAVAILABLE'),{status:503});return r.data},fetchMemberMedia:mediaAccess});
 const api=createCommercialTeamApi({db,resolveTrustedSuperadmin,retrieveMemberMedia,sendClaimed:createCommercialTeamSender({pool,send:manualWhatsappSender}),sendFormClaimed:createCommercialTeamFormSender({pool,send:emailSender})});
 registerCommercialTeamRoutes(app,{api,authUserFromBearer});
 return {enabled:true,pool,mode:'team'};
}
