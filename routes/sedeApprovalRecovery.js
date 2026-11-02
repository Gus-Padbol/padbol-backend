import {createSedeApprovalRecovery,createSedeApprovalOutboxWorker} from '../lib/sedeApprovalRecovery.js';
import {createSedeApprovalDeliverer} from '../lib/sedeApprovalDeliverer.js';

const prefix='/api/admin/sedes-pendientes/:id';
export function mountSedeApprovalRecoveryRoutes(app,{enabled=false,pool,authUserFromBearer,
  assertSuperAdminReq,deliver,...deliveryOptions}) {
  if(!enabled)return {enabled:false};
  if(!pool?.connect || !pool?.query)throw new Error('SEDE_APPROVAL_DATABASE_REQUIRED');
  const service=createSedeApprovalRecovery({pool});
  const worker=createSedeApprovalOutboxWorker({pool,deliver:deliver ||
    createSedeApprovalDeliverer({pool,...deliveryOptions})});
  const route=action=>async(req,res)=>{
    try {
      const user=await authUserFromBearer(req);
      if(!user?.id)return res.status(401).json({error:'No autorizado'});
      // Both the HTTP scope and the transaction verify the authenticated actor.
      await assertSuperAdminReq(req);
      const requestId=String(req.params.id||'');
      if(!/^[1-9]\d*$/.test(requestId)||!Number.isSafeInteger(Number(requestId)))
        return res.status(400).json({error:'Id inválido',code:'INVALID_APPROVAL_ID'});
      const result=await action({actorId:user.id,requestId:Number(requestId)},req.body||{});
      return res.json(result);
    } catch(error) {
      const known=Number.isInteger(error.status)&&error.status>=400&&error.status<500;
      return res.status(known?error.status:503).json({
        error:known?'No se pudo completar la operación.':'Recuperación de sede no disponible.',
        code:known&&/^[A-Z_]+$/.test(error.code||'')?error.code:'SEDE_APPROVAL_UNAVAILABLE',
      });
    }
  };
  app.post(prefix+'/aprobar',route(input=>service.approve(input)));
  app.get(prefix+'/estado-aprobacion',route(input=>service.status(input)));
  app.post(prefix+'/recuperar',route((input,body)=>{
    if(!/^[1-9]\d*$/.test(String(body.sede_id||''))||!Number.isSafeInteger(Number(body.sede_id)))
      throw Object.assign(new Error(),{status:400,code:'INVALID_APPROVAL_ID'});
    return service.approve({...input,recoverySedeId:Number(body.sede_id)});
  }));
  app.post(prefix+'/conciliar-entrega',route((input,body)=>service.reconcileDelivery({
    ...input,kind:body.kind,outcome:body.outcome,evidenceReference:body.evidence_reference,
    authUserId:body.auth_user_id,authOrigin:body.auth_origin,
  })));
  app.post(prefix+'/procesar-entregas',route(async input=>{
    // Status performs database authorization before the worker can contact a transport.
    await service.status(input);
    const results=[];
    for(let i=0;i<5;i++){
      const result=await worker.runOne({requestId:input.requestId});results.push(result);
      if(!result.processed)break;
    }
    return {ok:true,results,...await service.status(input)};
  }));
  return {enabled:true};
}
