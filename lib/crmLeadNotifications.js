import {buildLeadNotification} from './webPushNotifications.js';

const FORM='form', WHATSAPP='whatsapp';

export function createLeadNotificationService({db, webPush=null, logger=console}={}) {
  if(!db) throw new Error('db required');

  async function recipientsFor(conversationId, caseType) {
    const ids=new Set();
    if(caseType===FORM){
      const {data}=await db.from('crm_commercial_form_cases').select('assigned_user_id').eq('conversation_id',conversationId).maybeSingle();
      if(data?.assigned_user_id)ids.add(data.assigned_user_id);
    }else{
      const {data}=await db.from('crm_commercial_cases').select('assigned_user_id').eq('conversation_id',conversationId).maybeSingle();
      if(data?.assigned_user_id)ids.add(data.assigned_user_id);
    }
    const {data:roles}=await db.from('user_roles').select('user_id').in('role',['super_admin','admin']);
    for(const row of roles||[])if(row.user_id)ids.add(row.user_id);
    return [...ids];
  }

  async function notify({conversation, caseType=FORM}={}) {
    if(!conversation?.id)return {created:0,sent:0,recipients:0};
    const {data:contact}=await db.from('crm_contacts').select('nombre').eq('id',conversation.contact_id).maybeSingle();
    const country=conversation.qualification_data?.pais||conversation.qualification_data?.country||null;
    const name=contact?.nombre||'Nuevo contacto';
    const recipientIds=await recipientsFor(conversation.id,caseType);
    let created=0,sent=0;
    for(const userId of recipientIds){
      const payload=buildLeadNotification({name,country,origin:caseType===FORM?'formulario web':'WhatsApp',caseUrl:'/crm-leads',kind:'new'});
      const row={user_id:userId,case_type:caseType,case_id:conversation.id,conversation_id:conversation.id,title:payload.title,body:payload.body,link:'/crm-leads'};
      const {data:inserted,error}=await db.from('crm_lead_notifications').upsert(row,{onConflict:'user_id,case_type,case_id',ignoreDuplicates:true}).select('id').maybeSingle();
      if(error){logger?.warn?.('[lead-notification] upsert failed',{code:error.code});continue;}
      if(!inserted?.id)continue;
      created++;
      if(webPush){try{const r=await webPush.notify({userId,payload});sent+=r?.sent||0;}catch(error){logger?.warn?.('[lead-notification] push failed',{code:error?.message});}}
    }
    return {created,sent,recipients:recipientIds.length};
  }

  async function notifyExisting(conversationId,caseType=FORM) {
    const {data:conversation,error}=await db.from('crm_conversations').select('*').eq('id',conversationId).maybeSingle();
    if(error||!conversation)throw Object.assign(new Error('Conversación no encontrada.'),{status:404});
    return notify({conversation,caseType});
  }

  async function notifyTest(userId) {
    if(!userId)throw Object.assign(new Error('user required'),{status:400});
    const id=crypto.randomUUID?.()||`00000000-0000-4000-8000-${String(Date.now()).padStart(12,'0').slice(-12)}`;
    const payload=buildLeadNotification({name:'Prueba controlada',country:'Argentina',origin:'prueba del sistema',caseUrl:'/crm-leads',kind:'new'});
    const row={user_id:userId,case_type:'test',case_id:id,conversation_id:null,title:payload.title,body:payload.body,link:'/crm-leads'};
    const {data:inserted}=await db.from('crm_lead_notifications').insert(row).select('id').single();
    let sent=0;
    if(webPush){try{const r=await webPush.notify({userId,payload});sent=r?.sent||0;}catch(error){logger?.warn?.('[lead-notification] test push failed',{code:error?.message});}}
    return {id:inserted?.id,created:1,sent};
  }

  async function list(userId) {
    const [{data:notifications},{count}]=await Promise.all([
      db.from('crm_lead_notifications').select('*').eq('user_id',userId).order('created_at',{ascending:false}).limit(20),
      db.from('crm_lead_notifications').select('id',{count:'exact',head:true}).eq('user_id',userId).is('read_at',null),
    ]);
    return {notifications:notifications||[],unread:count||0};
  }

  async function markRead(userId,id) {
    const {data,error}=await db.from('crm_lead_notifications').update({read_at:new Date().toISOString()}).eq('id',id).eq('user_id',userId).select('id').maybeSingle();
    if(error||!data)throw Object.assign(new Error('Notificación no encontrada.'),{status:404});
    return {ok:true};
  }

  return {notify,notifyExisting,notifyTest,list,markRead};
}
