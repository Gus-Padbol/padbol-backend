// Called only after the existing CRM ingress persisted a signed provider event.
// A link never merges records, grants permissions or copies form PII to AI.
export function createWelcomeInboundBridge({crmService,db,enabled=false,logger=console}) {
 return new Proxy(crmService,{get(target,key){
  if(key!=='ingestInbound')return Reflect.get(target,key);
  return async input=>{
   const result=await target.ingestInbound(input);
   const c=result?.conversation;
   if(!enabled||input?.source!=='whatsapp_cloud'||input.origin!=='whatsapp:1376102838911694'||!c?.id||c.test_hidden_at||c.operador||c.derivado||!['nuevo',null,undefined].includes(c.estado))return result;
   const menu=c.qualification_data?.whatsapp_menu;
   const suppressed=()=>menu?.welcomeLinked ? {...result,conversation:{...c,qualification_data:{...c.qualification_data,whatsapp_menu:{...menu,topic:'otros',welcomeLinked:false}}}} : result;
   if(menu && !menu.welcomeLinked)return result; // Never replace a user's chosen path.
   const digits=String(input.phone||'');if(!/^[1-9][0-9]{7,14}$/.test(digits))return result;
   try {
    const {data,error}=await db.rpc('crm_link_welcome_verified_inbound_candidate',{p_whatsapp:c.id,p_phone:`+${digits}`,p_provider_id:input.sourceId});
    if(error||!['linked','already_linked'].includes(data?.status)||!['es','en'].includes(data?.language))return suppressed();
    if(/^(?:STOP|BAJA|CANCELAR|UNSUBSCRIBE)[.!\s]*$/i.test(String(input.body||''))){await db.rpc('crm_revoke_welcome_candidate',{p_conversation:data.lead_conversation_id});return suppressed();}
    return {...result,conversation:{...c,qualification_data:{...c.qualification_data,whatsapp_menu:{...menu,stage:'selected',topic:'sede',language:data.language,welcomeLinked:true}}}};
   }catch{logger?.warn?.('[crm-welcome] inbound association unavailable');return suppressed();}
  };
 }});
}
