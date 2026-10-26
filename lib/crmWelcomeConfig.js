// A guarded read-only approval check. The integration is inert until explicit
// configuration, verified templates and an operational Chivi are present.
const WABA='928900479733370';
const PHONE='1376102838911694';
const expected={
 es:'Hola, {{1}}. Somos el equipo de Padbol International.\n\nYa recibimos tu consulta y nos pondremos en contacto contigo lo antes posible para conversar sobre tu proyecto.\n\nSi quieres, puedes indicarnos qué días y horarios te resultan más cómodos para hablar. Cuanto más amplia sea tu disponibilidad, más fácil será coordinar una conversación.\n\nMientras tanto, si quieres conocer más sobre Padbol o resolver algunas dudas, puedes conversar por aquí con Chivi, nuestro asistente virtual.\n\n¿Qué te gustaría saber?',
 en:'Hello, {{1}}. We are the Padbol International team.\n\nWe have received your enquiry and will contact you as soon as possible to talk about your project.\n\nIf you would like, please let us know which days and times work best for you. The wider your availability, the easier it will be to arrange a conversation.\n\nIn the meantime, if you would like to learn more about Padbol or have any questions, you can chat here with Chivi, our virtual assistant.\n\nWhat would you like to know?',
};
export const welcomeBodies=Object.freeze(expected);

export async function verifyWelcomeTemplates({enabled=false,chiviReady=false,phoneId,wabaId,version,accessToken,templates={},fetchImpl=globalThis.fetch}={}) {
 if(enabled!==true || chiviReady!==true)return {ready:false,reason:'disabled_or_chivi_unavailable'};
 if(phoneId!==PHONE||wabaId!==WABA||!/^v\d{1,3}\.\d{1,2}$/.test(version||'')||!accessToken||typeof fetchImpl!=='function')return {ready:false,reason:'invalid_configuration'};
 const verified={};
 for(const language of ['es','en']){
  const candidate=templates[language];
  if(!/^[a-z0-9_]{1,512}$/.test(candidate?.name||'')||!(language==='es'?/^es(?:_[A-Z]{2})?$/:/^en(?:_[A-Z]{2})?$/).test(candidate?.locale||''))return {ready:false,reason:`invalid_template_${language}`};
  const url=new URL(`https://graph.facebook.com/${version}/${WABA}/message_templates`);
  url.searchParams.set('name',candidate.name);url.searchParams.set('fields','name,status,language,components');url.searchParams.set('limit','100');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
  try {
   const res=await fetchImpl(url,{headers:{Authorization:`Bearer ${accessToken}`},signal:controller.signal,redirect:'error'});
   if(!res.ok||res.redirected)return {ready:false,reason:`meta_unavailable_${language}`};
   const payload=await res.json();
   const matches=(Array.isArray(payload?.data)?payload.data:[]).filter(x=>x.name===candidate.name && x.language===candidate.locale && x.status==='APPROVED');
   if(matches.length!==1 || !Array.isArray(matches[0].components) || matches[0].components.length!==1 || matches[0].components[0]?.type!=='BODY' || matches[0].components[0]?.text!==expected[language])return {ready:false,reason:`template_not_approved_or_mismatch_${language}`};
   verified[language]={name:candidate.name,locale:candidate.locale,approved:true,body:expected[language]};
  } catch{return {ready:false,reason:`meta_unavailable_${language}`}} finally{clearTimeout(timer)}
 }
 return {ready:true,templates:verified};
}
