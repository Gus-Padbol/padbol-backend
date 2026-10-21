import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTorneoInteresRoutes } from './torneoInteres.js';
import { mountListaEsperaGeneralRoutes } from './listaEsperaGeneral.js';

function dbFor(tables, cap = 2) {
  return { from(table) {
    let rows = tables[table] || [], last = null, key = null, limit = Infinity;
    const q = { select() { return q; }, eq(k,v) { rows = rows.filter(r => r[k] === v); return q; },
      gt(k,v) { rows = rows.filter(r => r[k] > v); return q; }, in(k,values) { rows = rows.filter(r => values.includes(r[k])); return q; },
      order(k) { key=k; return q; }, limit(n) { limit=n; return q; },
      then(resolve,reject) { try { const sorted = [...rows].sort((a,b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0); last={ data: sorted.slice(0,Math.min(limit,cap)), error:null }; return Promise.resolve(last).then(resolve,reject); } catch (e) { return Promise.reject(e).then(resolve,reject); } } };
    return q;
  } };
}
function setup(role, tables) {
  const routes = {};
  const app = Object.fromEntries(['get','post','delete'].map(m => [m,(p,h) => { routes[`${m} ${p}`]=h; }]));
  const deps={supabaseAdmin:dbFor(tables),getAuthenticatedUser:async()=>({user:{id:'admin',email:'admin@example.test'}}),fetchUserRoleRowForAuthUser:async()=>role};
  mountTorneoInteresRoutes(app,deps); mountListaEsperaGeneralRoutes(app,deps);
  return routes;
}
async function invoke(handler,sid) {
  const res={code:200,status(c){this.code=c;return this},json(v){this.body=v;return this}};
  await handler({params:{id:String(sid),sede_id:String(sid)}},res); return res;
}
const tables = {
  torneo_interes: [1,2,3,4,5].map(i=>({id:i,sede_id:7,user_id:`user-${i}`,created_at:'2026-01-01'})).concat([{id:6,sede_id:8,user_id:'other',created_at:'2026-01-01'}]),
  lista_espera_general: [1,2,3].map(i=>({id:i,sede_id:7,user_id:`user-${i}`,deporte:'padbol',created_at:'2026-01-01'})),
  jugadores_perfil: [1,2,3,4,5].map(i=>({user_id:`user-${i}`,nombre:`Jugador ${i}`})),
};
test('ambas consultas recuperan todas las páginas sin mezclar otra sede', async()=>{
  const routes=setup({role:'admin_club',sede_id:7},tables);
  const a=await invoke(routes['get /api/admin/sedes/:id/torneo-interes'],7);
  const b=await invoke(routes['get /api/admin/lista-espera-general/:sede_id'],7);
  assert.equal(a.code,200); assert.equal(a.body.interesados.length,5);
  assert.equal(b.body.lista.length,3); assert.ok(a.body.interesados.every(r=>r.user_id!=='other' && r.nombre));
});
test('administrador no puede consultar otra sede', async()=>{
  const routes=setup({role:'admin_club',sede_id:8},tables);
  for (const key of ['get /api/admin/sedes/:id/torneo-interes','get /api/admin/lista-espera-general/:sede_id']) {
    const res=await invoke(routes[key],7); assert.equal(res.code,403); assert.equal(res.body.interesados,undefined); assert.equal(res.body.lista,undefined);
  }
});
