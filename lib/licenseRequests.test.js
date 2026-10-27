import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLicenseRequestPayload, licenseRequestPayloadHash, licenseRequestToCrmIngest, ingestLicenseRequestInCrm } from '../routes/licenseRequests.js';

test('license request requires a valid contact email', () => {
  assert.match(
    buildLicenseRequestPayload({
      email: 'invalid',
      club_nombre: 'Club',
      responsable_nombre: 'Persona',
      pais: 'Argentina',
      ciudad: 'Buenos Aires',
    }).error,
    /email/i,
  );
});

test('license request normalizes public input and forces pending state', () => {
  const parsed = buildLicenseRequestPayload({
    email: ' ADMIN@EXAMPLE.COM ',
    club_nombre: ' Club Norte ',
    responsable_nombre: ' Ana ',
    pais: ' Argentina ',
    ciudad: ' Córdoba ',
    estado: 'aprobada',
    deportes_canchas: { deportes: ['padbol'] },
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.email, 'admin@example.com');
  assert.equal(parsed.data.club_nombre, 'Club Norte');
  assert.equal(parsed.data.estado, 'pendiente');
  assert.deepEqual(parsed.data.deportes_canchas, { deportes: ['padbol'] });
  assert.equal(parsed.data.whatsapp_followup_consent, false);
  assert.equal(parsed.data.whatsapp_followup_consent_source, null);
  assert.equal(parsed.data.whatsapp_followup_consent_version, null);
  assert.equal(parsed.data.whatsapp_followup_consent_text, null);
  assert.equal(parsed.data.whatsapp_followup_consent_at, null);
});

test('license request stores specific WhatsApp follow-up consent separately from marketing', () => {
  const before = Date.now();
  const parsed = buildLicenseRequestPayload({
    email: 'club@example.com',
    club_nombre: 'Club Norte',
    responsable_nombre: 'Ana',
    whatsapp: '+54 9 221 555 1234',
    whatsapp_followup_consent: true,
    whatsapp_followup_consent_source: 'web:contacto_business',
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.whatsapp_followup_consent, true);
  assert.equal(parsed.data.whatsapp_followup_consent_source, 'web:contacto_business');
  assert.equal(parsed.data.whatsapp_followup_consent_version, 'whatsapp-followup-v1');
  assert.match(parsed.data.whatsapp_followup_consent_text, /seguimiento a esta solicitud/i);
  assert.match(parsed.data.whatsapp_followup_consent_text, /no incluye comunicaciones de marketing/i);
  assert.ok(Date.parse(parsed.data.whatsapp_followup_consent_at) >= before);
});

test('idempotency payload hash ignores generated consent timestamp but detects changed content', () => {
  const base = buildLicenseRequestPayload({
    email: 'club@example.com', club_nombre: 'Club Norte', responsable_nombre: 'Ana',
    whatsapp_followup_consent: true,
  }).data;
  const retry = { ...base, whatsapp_followup_consent_at: new Date(Date.now() + 1000).toISOString() };
  assert.equal(licenseRequestPayloadHash(base), licenseRequestPayloadHash(retry));
  assert.notEqual(licenseRequestPayloadHash(base), licenseRequestPayloadHash({ ...retry, club_nombre: 'Otro Club' }));
});

test('license request is converted into one CRM conversation from dev.padbol.com', () => {
  const parsed = buildLicenseRequestPayload({
    email: 'CLUB@EXAMPLE.COM',
    club_nombre: 'Club Norte',
    responsable_nombre: 'Ana Pérez',
    responsable_cargo: 'Gerente',
    whatsapp: '+54 9 221 555 1234',
    pais: 'Argentina',
    ciudad: 'La Plata',
    mensaje: 'Quiero recibir información comercial.',
  });
  const ingest = licenseRequestToCrmIngest('request-123', parsed.data);

  assert.equal(ingest.source, 'form');
  assert.equal(ingest.sourceId, 'request-123');
  assert.equal(ingest.channel, 'email');
  assert.equal(ingest.origin, 'web_form:dev_padbol_contacto_business');
  assert.equal(ingest.email, 'club@example.com');
  assert.equal(ingest.phone, '+54 9 221 555 1234');
  assert.equal(ingest.nombre, 'Ana Pérez');
  assert.match(ingest.subject, /dev\.padbol\.com/);
  assert.match(ingest.body, /Club Norte/);
  assert.match(ingest.body, /La Plata, Argentina/);
});


test('license CRM intake preserves structured answers and schedules analysis only for accepted submissions', async () => {
  const payload = buildLicenseRequestPayload({email:'person@example.test',club_nombre:'Club',responsable_nombre:'Person',pais:'Argentina',ciudad:'La Plata'}).data;
  const ingest = licenseRequestToCrmIngest('id',payload);
  assert.equal(ingest.qualificationData.form_submission.fields.Ciudad,'La Plata');
  assert.equal(ingest.qualificationData.routing.country,'Argentina');
  let calls=0, received;
  await ingestLicenseRequestInCrm({ingestInbound:async value=>{received=value;return {status:'accepted'};}},'id',payload,async()=>{calls++;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received.qualificationData.lead_analysis_request.status,'pending');assert.equal(calls,1);
  await ingestLicenseRequestInCrm({ingestInbound:async()=>({status:'idempotent'})},'id',payload,async()=>{calls++;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  await ingestLicenseRequestInCrm({ingestInbound:async value=>{received=value;return {status:'accepted'};}},'id',payload);
  assert.equal(received.qualificationData.lead_analysis_request.status,'disabled');
});

test('license HTTP route reports schema mismatch without exposing provider details or ingesting CRM', async()=>{
 const {mountLicenseRequestRoutes}=await import('../routes/licenseRequests.js');
 let handler,ingested=0;const app={post(path,...steps){if(path==='/api/solicitudes-licencia')handler=steps.at(-1);},get(){}};
 const result={error:{code:'PGRST204',message:'private schema diagnostic'}};
 const query={insert(){return this;},select(){return this;},single:async()=>result};
 mountLicenseRequestRoutes(app,{supabaseAdmin:{from:()=>query},crmService:{ingestInbound:async()=>{ingested++;}}});
 const response={status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
 await handler({body:{club_nombre:'Club',responsable_nombre:'Person',email:'person@example.test'},headers:{}},response);
 assert.equal(response.statusCode,503);assert.equal(response.body.code,'LICENSE_REQUESTS_NOT_CONFIGURED');assert.equal(ingested,0);assert.doesNotMatch(JSON.stringify(response.body),/private schema/);
});

test('persisted license remains successful when optional CRM incorporation fails',async()=>{
 const {mountLicenseRequestRoutes}=await import('../routes/licenseRequests.js');
 let handler;const app={post(path,...steps){if(path==='/api/solicitudes-licencia')handler=steps.at(-1);},get(){}};
 const query={insert(){return this;},select(){return this;},single:async()=>({data:{id:'saved-request',estado:'pendiente'},error:null})};
 mountLicenseRequestRoutes(app,{supabaseAdmin:{from:()=>query},crmService:{ingestInbound:async()=>{throw Error('synthetic CRM failure');}}});
 const response={status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
 await handler({body:{club_nombre:'Club',responsable_nombre:'Person',email:'person@example.test'},headers:{}},response);
 assert.equal(response.statusCode,201);assert.equal(response.body.id,'saved-request');
});
