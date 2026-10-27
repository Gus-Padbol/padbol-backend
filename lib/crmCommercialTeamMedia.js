// : actor and superadmin must come exclusively from a verified session.
// Recheck membership and assignment version after the remote fetch before
// exposing bytes; no raw media IDs supplied by the client are accepted.
export function createCommercialTeamMedia({guard, fetchMemberMedia}) {
 if(typeof guard!=='function'||typeof fetchMemberMedia!=='function')throw Error('COMMERCIAL_TEAM_MEDIA_CONFIG_INVALID');
 return async ({actor,superadmin,caseId,eventId})=>{
  if(!actor?.id||!caseId||!eventId)throw Object.assign(Error('NOT_FOUND'),{status:404});
  const before=await guard({actorId:actor.id,superadmin,caseId,eventId});
  if(!before?.conversationId||!Number.isSafeInteger(before.version)||before.version<0)throw Object.assign(Error('NOT_FOUND'),{status:404});
  const result=await fetchMemberMedia({user:actor,conversationId:before.conversationId,eventId});
  const after=await guard({actorId:actor.id,superadmin,caseId,eventId});
  if(!after||after.conversationId!==before.conversationId||after.version!==before.version)throw Object.assign(Error('NOT_FOUND'),{status:404});
  return result;
 };
}
