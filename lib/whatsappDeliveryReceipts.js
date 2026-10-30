const statuses = new Set(['sent','delivered','read','failed']);
const digits = v => typeof v === 'string' && /^[1-9][0-9]{5,31}$/.test(v);
// Called only after the existing Meta signature (or authenticated relay) check.
export function extractWhatsappDeliveryReceipts(payload, now = new Date()) {
 const result=[];
 if(payload?.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))return result;
 for(const entry of payload.entry)for(const change of Array.isArray(entry?.changes)?entry.changes:[]){
  if(change?.field!=='messages'||!digits(entry.id)||!digits(change.value?.metadata?.phone_number_id))continue;
  for(const value of Array.isArray(change.value?.statuses)?change.value.statuses:[]){
   if(result.length>=1000)throw Error('WHATSAPP_RECEIPT_LIMIT');
   if(typeof value?.id!=='string'||!/^wamid\.[A-Za-z0-9_+/=-]{1,500}$/.test(value.id)||!statuses.has(value.status)||!digits(value.recipient_id)||!/^\d{10}$/.test(String(value.timestamp)))continue;
   const ms=Number(value.timestamp)*1000;
   if(ms<Date.UTC(2020,0,1)||ms>now.getTime()+300000)continue;
   result.push({wabaId:entry.id,phoneNumberId:change.value.metadata.phone_number_id,providerMessageId:value.id,status:value.status,recipient:value.recipient_id,at:new Date(ms).toISOString(),errorCode:value.status==='failed'&&Number.isInteger(value.errors?.[0]?.code)?value.errors[0].code:null});
  }
 }
 return result;
}
export function createWhatsappDeliveryHandler(db) {
 if(typeof db?.rpc!=='function')throw Error('WHATSAPP_RECEIPTS_DB_REQUIRED');
 return async receipt=>{
  const {error}=await db.rpc('whatsapp_record_delivery_receipt',{p_phone:receipt.phoneNumberId,p_waba:receipt.wabaId,p_provider:receipt.providerMessageId,p_recipient:receipt.recipient,p_status:receipt.status,p_at:receipt.at,p_error:receipt.errorCode});
  if(error)throw Object.assign(Error('WHATSAPP_RECEIPT_STORE_FAILED'),{code:'WHATSAPP_RECEIPT_STORE_FAILED',status:503});
 };
}
