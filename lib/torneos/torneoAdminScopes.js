/** Pure scope policy used by server/RPC callers; persistence is migration 20261114160000. */
export function evaluateTorneoAdminScope({userId,torneoId,canchaId=null,role,scope}={}) {
  if(!userId||!Number.isSafeInteger(Number(torneoId))||Number(torneoId)<=0)return {allowed:false,reason:'INVALID_INPUT'};
  if(String(role?.role??role?.rol??'').toLowerCase()==='super_admin')return {allowed:true,reason:'SUPER_ADMIN'};
  if(!scope||scope.revoked_at)return {allowed:false,reason:'NO_SCOPE'};
  if(Number(scope.torneo_id)!==Number(torneoId))return {allowed:false,reason:'WRONG_TOURNAMENT'};
  const canchas=Array.isArray(scope.cancha_ids)?scope.cancha_ids.map(Number):[];
  if(canchaId!=null&&canchas.length>0&&!canchas.includes(Number(canchaId)))return {allowed:false,reason:'WRONG_COURT'};
  return {allowed:true,reason:'SCOPED'};
}
