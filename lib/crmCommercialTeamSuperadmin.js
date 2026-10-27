// Only a confirmed bearer identity bound to the same stored user_id and email
// can receive global authority. A failed lookup fails closed.
export function createCommercialSuperadminResolver(db){
 return async user=>{
  if(!db?.from)throw Error('COMMERCIAL_ROLE_STORE_INVALID');
  if(!user?.id || !user?.email || !user.email_confirmed_at)return false;
  const email=String(user.email).trim().toLowerCase();
  const {data,error}=await db.from('user_roles').select('user_id,email,role').eq('user_id',user.id).maybeSingle();
  if(error)throw Error('COMMERCIAL_ROLE_LOOKUP_FAILED');
  return Boolean(data && String(data.user_id)===String(user.id) && String(data.email||'').trim().toLowerCase()===email && String(data.role||'').trim().toLowerCase()==='super_admin');
 };
}
