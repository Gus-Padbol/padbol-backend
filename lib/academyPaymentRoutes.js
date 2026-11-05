import { timingSafeEqual } from 'node:crypto';

// Prices in USD cents match the web's api/academy/_catalog.ts. Course IDs are
// the authorized ES/EN variants; product_id remains unset rather than invented.
export const ACADEMY_PAYMENT_PRODUCTS = Object.freeze(Object.fromEntries([
  ['coach_jugadores',35000,[94439,94411]],
  ['coach_formador',60000,[94439,94411]],
  ['modulo_infantil',10000,[94460,94446]],
  ['masterclass_fide',50000,[95062,95064]],
  ['arbitro_nacional',10000,[94436,94383]],
  ['arbitro_internacional',25000,[94436,94383]],
  ['formador_arbitros',30000,[94436,94383]],
].map(([code,amount,courses])=>[code,Object.freeze({amount,courseIds:Object.freeze(courses)})])));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizedEmail = value => typeof value==='string' && value.length<=320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
function trustedSecret(req,secret) {
  const header=req.headers?.authorization;
  if(typeof header!=='string'||header.length>4096||typeof secret!=='string'||!secret.length)return false;
  const match=/^Bearer ([^\r\n]+)$/i.exec(header);
  const actual=Buffer.from(match?.[1]||'','utf8'),expected=Buffer.from(secret,'utf8');
  return actual.length===expected.length&&actual.length>0&&timingSafeEqual(actual,expected);
}
function rpcFailure(error) {
  if(String(error?.message||'').includes('ACADEMY_PAYMENT_CONFLICT'))return fail(409,'ACADEMY_PAYMENT_CONFLICT');
  if(String(error?.message||'').includes('ACADEMY_PAYMENT_INVALID'))return fail(400,'ACADEMY_PAYMENT_INVALID');
  if(String(error?.message||'').includes('ACADEMY_IDENTITY_REQUIRED'))return fail(403,'ACADEMY_IDENTITY_REQUIRED');
  return fail(503,'ACADEMY_PAYMENT_UNAVAILABLE');
}

/** Call only after server-side bearer authentication. Never trust user_metadata. */
export async function claimAcademyPayments(db,user) {
  const email=normalizedEmail(user?.email);
  if(!UUID.test(String(user?.id||''))||!email||!user?.email_confirmed_at)throw fail(403,'ACADEMY_IDENTITY_REQUIRED');
  if(typeof db?.rpc!=='function')throw fail(503,'ACADEMY_PAYMENT_UNAVAILABLE');
  let result;
  try {result=await db.rpc('academy_claim_payment_grants',{p_user_id:user.id,p_email:email});}
  catch {throw fail(503,'ACADEMY_PAYMENT_UNAVAILABLE');}
  if(result?.error)throw rpcFailure(result.error);
  if(!result?.data||typeof result.data!=='object')throw fail(503,'ACADEMY_PAYMENT_UNAVAILABLE');
  return result.data;
}

export function registerAcademyPaymentRoutes(app,{db,authUserFromBearer,inboundSecret,logger=console}={}) {
  if(typeof db?.rpc!=='function')throw Error('ACADEMY_PAYMENT_CONFIG_INVALID');
  // This service-to-service route intentionally accepts no student bearer identity.
  // The Vercel caller verifies Stripe's signature before using the shared secret.
  app.post('/api/inbound/academy/payment',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      if(typeof inboundSecret!=='string'||!inboundSecret.length)throw fail(503,'ACADEMY_PAYMENT_UNAVAILABLE');
      if(!trustedSecret(req,inboundSecret))throw fail(401,'UNAUTHENTICATED');
      const body=req.body,email=normalizedEmail(body?.email);
      const product=typeof body?.productCode==='string'&&Object.hasOwn(ACADEMY_PAYMENT_PRODUCTS,body.productCode)?ACADEMY_PAYMENT_PRODUCTS[body.productCode]:null;
      if(!body||Array.isArray(body)||!product||!email||typeof body.sessionId!=='string'||!/^cs_live_[A-Za-z0-9]{1,240}$/.test(body.sessionId)
        ||typeof body.eventId!=='string'||!/^evt_[A-Za-z0-9]{1,240}$/.test(body.eventId)
        ||body.livemode!==true||body.paymentStatus!=='paid'||body.currency!=='usd'||!Number.isSafeInteger(body.amountTotal)||body.amountTotal<=0)throw fail(400,'ACADEMY_PAYMENT_INVALID');
      // The transactional RPC enforces the exact catalog price and distinguishes
      // a changed existing session (409) from a new invalid payment (400).
      const {data,error}=await db.rpc('academy_record_payment_grant',{p_session_id:body.sessionId,p_event_id:body.eventId,p_product_code:body.productCode,p_email:email,p_amount_total:body.amountTotal,p_currency:body.currency,p_payment_status:body.paymentStatus,p_livemode:body.livemode});
      if(error)throw rpcFailure(error);
      if(!data||!['pending','granted'].includes(data.status))throw fail(503,'ACADEMY_PAYMENT_UNAVAILABLE');
      return res.json({ok:true,status:data.status});
    } catch(error) {
      const status=Number.isInteger(error?.status)?error.status:503;
      const code=error?.code||'ACADEMY_PAYMENT_UNAVAILABLE';
      if(status>=500)logger.error?.('[academy-payment]',{code});
      return res.status(status).json({error:code,code});
    }
  });
  return true;
}
