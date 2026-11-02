import {randomBytes} from 'node:crypto';

// Adaptador explicitamente inyectado. No envía al importarlo y nunca ejecuta
// callbacks, SQL o URLs provenientes del navegador o de una fila de cliente.
export function createSedeApprovalDeliverer({pool,supabaseAdmin,runtime,frontendUrl,sendWhatsapp,lookupCreatorWhatsapp,sendRegistrationEvent}){
  const stop=code=>Object.assign(new Error(code),{blocked:true});
  return async function deliver({requestId,kind}){
    if(!runtime?.outboundDeliveryEnabled)throw stop('OUTBOUND_DISABLED');
    let rows;
    try{({rows}=await pool.query("SELECT o.delivery_context,o.sede_id,(SELECT attempts FROM public.sede_approval_outbox j WHERE j.request_id=o.request_id AND j.kind='auth_user') AS auth_attempts FROM public.sede_approval_operations o WHERE o.request_id=$1",[requestId]));}
    catch{throw Object.assign(new Error('APPROVAL_CONTEXT_READ_FAILED'),{safeToRetry:true});}
    if(rows.length!==1)throw stop('APPROVAL_CONTEXT_MISSING');
    const p=rows[0].delivery_context||{},email=String(p.licenciatario_email||'').trim().toLowerCase();
    if(!email)throw stop('LICENSEE_EMAIL_MISSING');
    if(kind==='auth_user'){
      // La unicidad de Auth por email hace reintentable solo este paso. No
      // restablecer contraseña de una cuenta existente ni degradar sus roles.
      const result=await supabaseAdmin.auth.admin.createUser({email,password:randomBytes(32).toString('base64url'),email_confirm:true,user_metadata:{temp_password:true}});
      if(result.error){
        if(['email_exists','user_already_exists'].includes(result.error.code)){
          // After a prior attempt this may be our newly created user whose
          // acknowledgement was lost. Do not misclassify it as pre-existing.
          if(Number(rows[0].auth_attempts)>1)throw stop('AUTH_PROVENANCE_REVIEW_REQUIRED');
          return {accepted:true,reference:'auth:already-exists'};
        }
        throw Object.assign(new Error('AUTH_PROVISION_FAILED'),{safeToRetry:true});
      }
      if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(result.data?.user?.id||''))throw Object.assign(new Error('AUTH_ACK_MISSING'),{safeToRetry:true});
      return {accepted:true,reference:`auth:${result.data.user.id}`};
    }
    if(kind==='registration_event'){
      const result = await pool.query("SELECT provider_reference FROM public.sede_approval_outbox WHERE request_id=$1 AND kind='auth_user' AND state='succeeded'",[requestId]);
      const reference=result.rows[0]?.provider_reference;
      if(reference==='auth:already-exists'||/^auth:existing:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(reference||''))return {skipped:true,reference:'skipped:existing-auth-user'};
      if(!/^auth:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(reference||''))throw stop('AUTH_PROVISION_RESULT_REQUIRED');
      if(typeof sendRegistrationEvent!=='function')throw stop('REGISTRATION_EVENT_NOT_CONFIGURED');
      const receipt=await sendRegistrationEvent('jugador_registrado',{email,nombre:String(p.licenciatario_nombre||'').trim()||null,pais:String(p.pais||'').trim()||null,ciudad:String(p.ciudad||'').trim()||null});
      if(receipt?.disabled||receipt?.skipped)return {skipped:true,reference:'skipped:registration-event-disabled'};
      if(receipt?.accepted===true)return {accepted:true,reference:receipt.reference||'make:accepted'};
      throw new Error('REGISTRATION_EVENT_DELIVERY_UNCERTAIN');
    }
    if(kind==='welcome_email'){
      let url;
      try{url=new URL('/login',frontendUrl);if(url.protocol!=='https:')throw Error();}catch{throw stop('FRONTEND_HTTPS_REQUIRED');}
      const result=await supabaseAdmin.auth.resetPasswordForEmail(email,{redirectTo:url.href});
      // Los errores de red o respuestas ambiguas no autorizan otro correo.
      if(result.error)throw new Error('WELCOME_DELIVERY_UNCERTAIN');
      return {accepted:true,reference:'supabase:accepted'};
    }
    if(!['whatsapp_creator','whatsapp_license'].includes(kind))throw stop('UNSUPPORTED_DELIVERY_KIND');
    const target=kind==='whatsapp_creator'?await lookupCreatorWhatsapp(p.created_by):p.licenciatario_telefono||p.whatsapp;
    if(!target)return {skipped:true,reference:'skipped:no-recipient'};
    const text=kind==='whatsapp_creator'?`✅ Sede ${p.nombre} aprobada en PADBOL Match.`:
      `🎉 Bienvenido a PADBOL Match. Tu sede "${p.nombre}" está activa.\nIngresa al panel: padbolmatch.com/admin`;
    const result=await sendWhatsapp(target,text);
    if(!result?.sid)throw new Error('WHATSAPP_ACK_UNCERTAIN');
    return {accepted:true,reference:String(result.sid)};
  };
}
