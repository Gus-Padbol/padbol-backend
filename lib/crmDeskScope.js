// Server-only CRM desk allowlist. It never changes platform roles, legacy
// WhatsApp administrator permissions, content access or commercial management.
export function readCrmDeskOperators(env={}){
 let entries;try{entries=JSON.parse(env.CRM_DESK_OPERATORS_JSON||'[]');}catch{return [];}
 if(!Array.isArray(entries)||entries.length>50)return [];
 const result=[],ids=new Set(),emails=new Set();
 for(const entry of entries){const email=String(entry?.email||'').trim().toLowerCase(),userId=entry?.userId;if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254||typeof userId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)||ids.has(userId.toLowerCase())||emails.has(email))return [];ids.add(userId.toLowerCase());emails.add(email);result.push(Object.freeze({email,userId:userId.toLowerCase()}));}
 return Object.freeze(result);
}
export function crmDeskOperatorPermissions({email,userId},entries=[]){
 const normalized=String(email||'').trim().toLowerCase(),id=String(userId||'').toLowerCase();
 const entry=entries.find(e=>e.email===normalized);if(!entry)return null;if(entry.userId!==id)return {role:'none',canOperate:false,canAudit:false,canManageVisibility:false,canDelete:false};
 return {role:'crm_desk_operator',canOperate:true,canAudit:false,canManageVisibility:false,canDelete:false,canOperateSupport:true,canOperateWhatsapp:true,canOperateEmail:true,deskOnly:true};
}

export function verifiedCrmDeskIdentity(user,row){return Boolean(user?.email_confirmed_at&&!user?.deleted_at&&row?.user_id===user.id&&String(row?.email||'').trim().toLowerCase()===String(user?.email||'').trim().toLowerCase());}
