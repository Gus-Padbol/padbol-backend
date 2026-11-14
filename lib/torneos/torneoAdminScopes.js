/** Pure scope policy; persistence is migration 20261114160000. */
export function evaluateTorneoAdminScope({userId,torneoId,canchaId=null,torneo=null,cancha=null,role,scope}={}) {
  if(!userId||!Number.isSafeInteger(Number(torneoId))||Number(torneoId)<=0)return {allowed:false,reason:'INVALID_INPUT'};
  if(String(role?.role??role?.rol??'').toLowerCase()==='super_admin')return {allowed:true,reason:'SUPER_ADMIN'};
  if(!scope||scope.revoked_at||String(scope.revoked_at??'').trim()!=='')return {allowed:false,reason:'NO_SCOPE'};
  if(scope.user_id!==userId)return {allowed:false,reason:'WRONG_USER'};
  if(Number(scope.torneo_id)!==Number(torneoId))return {allowed:false,reason:'WRONG_TOURNAMENT'};
  const canchaNum=Number(canchaId);
  if(!Number.isSafeInteger(canchaNum)||canchaNum<=0)return {allowed:false,reason:'COURT_REQUIRED'};
  const canchas=Array.isArray(scope.cancha_ids)?scope.cancha_ids.map(Number):[];
  if(!canchas.length)return {allowed:false,reason:'COURT_REQUIRED'};
  if(!canchas.includes(canchaNum))return {allowed:false,reason:'WRONG_COURT'};
  if(torneo&&cancha&&Number(cancha.sede_id)!==Number(torneo.sede_id))return {allowed:false,reason:'COURT_OUTSIDE_TOURNAMENT'};
  return {allowed:true,reason:'SCOPED'};
}
