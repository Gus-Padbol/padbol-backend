import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ADMIN_HELP_ARTICLES as articles } from '../lib/adminHelpArticles.js';
import { mountAdminHelpRoutes } from './adminHelp.js';
import { reviewHelpCorpus } from '../scripts/check-admin-help-corpus.mjs';
async function fixture(t,initialRole){let role=initialRole;const app=express();mountAdminHelpRoutes(app,{getAuthenticatedUser:async req=>req.headers.authorization==='Bearer fixture'?{user:{id:'synthetic'}}:{user:null},fetchUserRoleRowForAuthUser:async()=>({role,sede_id:7})});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return{setRole:r=>{role=r;},get:async path=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/help/${path}`,{headers:{authorization:'Bearer fixture'}});assert.equal(res.headers.get('cache-control'),'private, no-store');return{status:res.status,body:await res.json()};}};}
test('final reviewed corpus has twenty complete ES/EN/PT articles within role policy',()=>{assert.equal(articles.length,20);assert.deepEqual(reviewHelpCorpus(articles),[]);assert.equal(articles.find(a=>a.id==='admin-validaciones-rechazar').allowedRoles.join(','),'super_admin');assert.equal(articles.find(a=>a.id==='admin-incentivos-configuracion').allowedRoles.join(','),'super_admin');});
for(const role of ['super_admin','admin_club','admin_nacional','admin_cadena'])for(const lang of ['es','en','pt'])test(`complete corpus ${role}/${lang}: authorized summaries/details only`,async t=>{const f=await fixture(t,role),expected=articles.filter(a=>a.allowedRoles.includes(role));const list=await f.get(`search?lang=${lang}`);assert.equal(list.status,200);assert.equal(list.body.total,expected.length);assert.deepEqual(list.body.results.map(a=>a.id),expected.map(a=>a.id));for(const a of articles){const detail=await f.get(`articles/${a.module}/${a.slug}?lang=${lang}`);if(a.allowedRoles.includes(role)){assert.equal(detail.status,200);assert.equal(detail.body.article.title,a.translations[lang].title);assert.equal(detail.body.article.url,`/ayuda/administracion/${a.module}/${a.slug}`);}else{assert.equal(detail.status,403);assert.deepEqual(detail.body,{error:'HELP_FORBIDDEN',code:'HELP_FORBIDDEN'});}}f.setRole('jugador');assert.equal((await f.get(`search?lang=${lang}`)).status,403);});
test('practical questions find reviewed procedures, denied support never leaks',async t=>{const f=await fixture(t,'super_admin');for(const[lang,q,id]of[['es','cómo crear un torneo','admin-torneos-crear'],['en','how do I create a tournament','admin-torneos-crear'],['en','how do I add a court','admin-canchas-agregar-editar'],['es','cómo agregar una cancha','admin-canchas-agregar-editar'],['pt','como adicionar uma quadra','admin-canchas-agregar-editar'],['pt','como criar um torneio','admin-torneos-crear'],['es','renovar membresía','admin-membresias-asignadas'],['en','reply support tickets','admin-support-manage-tickets']]){const result=await f.get(`search?lang=${lang}&q=${encodeURIComponent(q)}`);assert.equal(result.status,200);assert.ok(result.body.results.some(a=>a.id===id),`${lang}: ${q}`);}f.setRole('admin_club');for(const lang of ['es','en','pt']){const result=await f.get(`search?lang=${lang}&q=tickets`);assert.equal(result.body.total,0);assert.doesNotMatch(JSON.stringify(result),/gestionar-tickets|super_admin/);}});
test('current guidance keeps bulk rejection private and club player instructions venue-scoped',async t=>{const club=await fixture(t,'admin_club');const rejected=await club.get('search?lang=es&q=rechazar%20seleccionados');assert.equal(rejected.status,200);assert.equal(rejected.body.total,0);const approval=await club.get('search?lang=es&q=aprobar%20seleccionados');assert.ok(approval.body.results.some(a=>a.id==='admin-validaciones-aprobar'));const player=articles.find(a=>a.id==='admin-jugadores');assert.match(player.translations.es.limit,/global.*super_admin/);assert.match(player.translations.en.limit,/global.*super_admin/);assert.match(player.translations.pt.limit,/global.*super_admin/);for(const id of ['admin-validaciones-aprobar','admin-validaciones-rechazar']){const article=articles.find(a=>a.id===id);assert.equal(article.sourceVersion.backend,'706f515a4473dab226fcc11be0b0964fbe3b687a');assert.ok(article.sourceRefs.some(ref=>ref.includes('useBulkPendingValidation')));}const superAdmin=await fixture(t,'super_admin');assert.ok((await superAdmin.get('search?lang=es&q=rechazar%20seleccionados')).body.results.some(a=>a.id==='admin-validaciones-rechazar'));});

test('Nations operator guidance stays in the existing protected article in all locales',async t=>{
 const club=await fixture(t,'admin_club');
 for(const lang of ['es','en','pt']){
  const result=await club.get(`search?lang=${lang}&q=Nations`);
  assert.ok(result.body.results.some(a=>a.id==='admin-marcador'));
  const detail=await club.get(`articles/marcador/marcador?lang=${lang}`);
  assert.equal(detail.status,200);
  assert.equal(detail.body.article.url,'/ayuda/administracion/marcador/marcador');
  const source=articles.find(a=>a.id==='admin-marcador').translations[lang];
  assert.equal(source.steps.length,10);
  assert.match(source.steps.slice(4).join(' '),/1, 3, 5, 7/);
  assert.match(source.steps.slice(4).join(' '),/tie-break/);
 }
 for(const role of ['jugador','admin_nacional','admin_cadena']){
  club.setRole(role);
  const detail=await club.get('articles/marcador/marcador?lang=es');
  assert.equal(detail.status,403);
  assert.doesNotMatch(JSON.stringify(detail.body),/Nations|Sustituye|game impar/);
 }
});

test('referee help follows the actual private-link and named-player consumer panel without changing article authority',()=>{
 const a=articles.find(a=>a.id==='admin-marcador');assert.deepEqual(a.allowedRoles,['admin_club','super_admin']);
 for(const lang of ['es','en','pt']){const text=a.translations[lang].steps.join(' ');for(const label of ['Crear enlace del árbitro','Iniciar partido','Registrar cambio','Reintentar el mismo intento','Cerrar seguimiento del partido terminado'])assert.ok(text.includes(label),`${lang}: ${label}`);assert.match(text,/1, 3, 5, 7/);assert.match(text,/tie-break/);assert.doesNotMatch(text,/UUID|JSON|SQL|https?:\/\/|control\//i);assert.ok(a.translations[lang].steps[9].indexOf('Cerrar seguimiento del partido terminado')>0);}
 for(const lang of ['es','en','pt'])for(const classic of ['Editar','Copiar link árbitro','Copiar link vista pública','Copiar link TV','QR'])assert.ok(a.translations[lang].steps[1].includes(classic));assert.match(a.translations.es.steps[1],/panel clásico/);assert.match(a.translations.en.steps[1],/classic panel/);assert.match(a.translations.pt.steps[1],/painel clássico/);assert.match(a.translations.es.steps[2],/privado.*sólo.*árbitro responsable/);assert.match(a.translations.en.steps[2],/private.*only.*responsible referee/);assert.match(a.translations.pt.steps[2],/privado.*apenas.*árbitro responsável/);
});
