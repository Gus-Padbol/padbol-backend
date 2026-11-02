// The conditional UPDATE takes the same row lock as transactional approval.
// A stale pre-read must never overwrite a just-approved request or send a notice.
export async function rejectPendingSede({db,requestId,reason}) {
  const fail=(code,status)=>Object.assign(new Error(code),{code,status});
  if(!Number.isSafeInteger(requestId)||requestId<1||typeof reason!=='string'||!reason.trim()||reason.trim().length>2000)
    throw fail('INVALID_REJECTION',400);
  const {data,error}=await db.from('sedes_pendientes')
    .update({estado:'rechazada',motivo_rechazo:reason.trim()})
    .eq('id',requestId).eq('estado','pendiente').select('id').maybeSingle();
  if(error)throw fail('REJECTION_DATABASE_UNAVAILABLE',503);
  if(!data||String(data.id)!==String(requestId))throw fail('REQUEST_NO_LONGER_PENDING',409);
  return {ok:true,request_id:requestId};
}
