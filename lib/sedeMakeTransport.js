// Only acknowledges webhook HTTP acceptance, never downstream delivery.
// Separate from the legacy best-effort helper so ambiguous results reach outbox.
export function createAcknowledgedMakeTransport({runtime,webhookUrl,fetchImpl=globalThis.fetch}) {
  return async (event,data={}) => {
    const blocked=code=>Object.assign(new Error(code),{blocked:true});
    if(!runtime?.outboundDeliveryEnabled)throw blocked('OUTBOUND_DISABLED');
    let url;
    try {url=new URL(webhookUrl);if(url.protocol!=='https:')throw Error();}
    catch {throw blocked('MAKE_HTTPS_CONFIGURATION_REQUIRED');}
    if(event!=='jugador_registrado')throw blocked('MAKE_EVENT_NOT_ALLOWED');
    // Fetch may have reached Make even if its response was lost. Never auto retry.
    let response;
    try {response=await fetchImpl(url.href,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...data,event,timestamp:new Date().toISOString()})});}
    catch {throw new Error('MAKE_ACCEPTANCE_UNCERTAIN');}
    if(!Number.isInteger(response?.status) || response.status<200 || response.status>=300)
      throw new Error('MAKE_ACCEPTANCE_UNCERTAIN');
    return {accepted:true,reference:`make:http-${response.status}`};
  };
}
