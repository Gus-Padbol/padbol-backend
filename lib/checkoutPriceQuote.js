import {createHash} from 'node:crypto';
import {normalizeCrearPreferenciaReservaInput} from '../routes/reservaPendienteMp.js';
import {quoteReservaPrice} from './pricing/quoteReservaPrice.js';
export const hasCheckoutQuote=body=>Object.hasOwn(body||{},'quote_confirmation');
const fail=(status,code)=>Object.assign(Error(code),{status,code});
export function checkoutQuoteParameters(body,user,{provider,sedeId,input=normalizeCrearPreferenciaReservaInput(body),readOnly=false}){
 const rd=body.reservaData||{};return{...(provider==='stripe'?{}:{priceContractVersion:body.price_confirmation_strict===true?2:1}),readOnlyMembership:readOnly,
 sedeId,deporte:input.deporte??rd.deporte??'padbol',duracionMinutos:input.duracion_minutos??rd.duracion_minutos??90,
 fecha:input.fecha??rd.fecha,hora:input.hora??input.hora_inicio??rd.hora,extras:body.extras??rd.extras??[],moneda:body.moneda,userId:user.id,email:user.email};
}
function mode(method,hint){const raw=String(method||'').trim().toLowerCase();if(['manual','presencial','efectivo','pago_en_sede','pago en sede'].includes(raw))return'manual';const list=raw.split(',').map(x=>x.trim());if(hint==='stripe'&&list.includes('stripe'))return'stripe';return list.length===1&&list[0]==='stripe'?'stripe':'mercadopago';}
function freshScope(body){const aliases=[body.sedeId,body.sede_id,body.reservaData?.sede_id].filter(v=>v!=null&&v!=='').map(Number);if(aliases.some(v=>!Number.isSafeInteger(v)||v<1)||new Set(aliases).size>1)throw fail(400,'CHECKOUT_QUOTE_CONTEXT_CONFLICT');const input=normalizeCrearPreferenciaReservaInput(body);if(input.reserva_id)throw fail(409,'CHECKOUT_EXISTING_RESERVATION_REVIEW');if(!Number.isSafeInteger(input.sede_id)||input.sede_id<1||!input.fecha||!input.hora||!input.cancha_id)throw fail(400,'CHECKOUT_QUOTE_CONTEXT_REQUIRED');return input;}
export async function checkoutQuoteDto(pool,body,user,quote,{input=freshScope(body)}={}){
 freshScope(body);
 const{rows}=await pool.query('SELECT metodo_pago, pago_manual_instrucciones FROM sedes WHERE id = $1 LIMIT 1',[input.sede_id]);if(!rows[0])throw fail(400,'CHECKOUT_QUOTE_INVALID_VENUE');
 const provider=mode(rows[0].metodo_pago,body.payment_provider);
 const version=provider==='stripe'?1:(body.price_confirmation_strict===true?2:1);
 if(input.hora_fin){const minutes=v=>{const[h,m]=String(v).split(':').map(Number);return h*60+m;};if((minutes(input.hora_fin)-minutes(input.hora)+1440)%1440!==quote.pricing_snapshot.duracion_minutos)throw fail(400,'CHECKOUT_QUOTE_DURATION_MISMATCH');}
 const extras=quote.extras.map(e=>({id:e.id,nombre:e.nombre,cantidad:e.cantidad,precio:e.precio,moneda:e.moneda}));
 const benefits=quote.membresia?{kind:quote.membresia.beneficio,discount_amount:quote.membresia.descuento_monto,included:quote.membresia.reserva_incluida}:null;
 const dto={quote_version:1,price_contract_version:version,sede_id:input.sede_id,fecha:input.fecha,hora:input.hora,cancha_id:input.cancha_id,duracion_minutos:quote.pricing_snapshot.duracion_minutos,deporte:quote.pricing_snapshot.deporte,
 payment_provider:provider,checkout_type:provider==='stripe'?'provider':quote.total===0?'free':provider==='manual'?'manual':'provider',precio_esperado:quote.total,moneda:quote.moneda,pricing:quote.pricing,extras,benefits,
 next_action:provider==='stripe'?'confirm_provider_checkout':quote.total===0?'confirm_free_reservation':provider==='manual'?'confirm_pay_at_venue':'confirm_provider_checkout'};
 const canonical={...dto,actor_id:user.id,hora_fin:input.hora_fin,membership:quote.membresia,extras:extras.slice().sort((a,b)=>Number(a.id)-Number(b.id))};
 dto.quote_confirmation=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');return dto;
}
export async function readCheckoutPriceQuote(db,pool,body,user){
 const input=freshScope(body);const{rows}=await pool.query('SELECT metodo_pago FROM sedes WHERE id=$1 LIMIT 1',[input.sede_id]);if(!rows[0])throw fail(400,'CHECKOUT_QUOTE_INVALID_VENUE');
 const provider=mode(rows[0].metodo_pago,body.payment_provider);
 const quote=await quoteReservaPrice(db,checkoutQuoteParameters(body,user,{provider,sedeId:input.sede_id,input,readOnly:true}));
 const dto=await checkoutQuoteDto(pool,body,user,quote,{input});
 return dto;
}
export async function assertOptionalCheckoutPriceQuote(pool,body,user,quote,endpointProvider,db){
 if(!hasCheckoutQuote(body))return;
 let dto=await checkoutQuoteDto(pool,body,user,quote);
 const correctEndpoint=endpointProvider==='stripe'?dto.payment_provider==='stripe':['manual','mercadopago'].includes(dto.payment_provider);
 if(!correctEndpoint&&db)dto=await readCheckoutPriceQuote(db,pool,body,user);
 const amountOk=body.precio==null||Number(body.precio)===dto.precio_esperado;
 if(typeof body.quote_confirmation!=='string'||body.quote_confirmation!==dto.quote_confirmation||!correctEndpoint||!amountOk){const error=fail(409,'CHECKOUT_QUOTE_CHANGED');error.fresh_quote=dto;throw error;}
}
export function checkoutQuoteRejection(error){return{error:error.code||'CHECKOUT_QUOTE_UNAVAILABLE',code:error.code||'CHECKOUT_QUOTE_UNAVAILABLE',operation_created:false,next_action:error.fresh_quote?'confirm_updated_quote':'review_status',...(error.fresh_quote?{fresh_quote:error.fresh_quote}:{})};}
export function createCheckoutPriceQuoteHandler({db,pool,getAuthenticatedUser}){return async(req,res)=>{try{const auth=await getAuthenticatedUser(req);if(!auth.user)return res.status(auth.status||401).json({error:auth.error||'No autorizado'});if(!db||!pool)throw fail(503,'CHECKOUT_QUOTE_UNAVAILABLE');return res.json(await readCheckoutPriceQuote(db,pool,req.body||{},auth.user));}catch(error){return res.status(error.status||503).json(checkoutQuoteRejection(error));}};}
