import test from 'node:test';
import assert from 'node:assert/strict';
import {canReadQaCatalogRow,pickPlayerSedeSummary} from './qaCatalogVisibility.js';
test('public and players cannot browse QA while authorized scoped operator keeps test access',()=>{
 const event={id:39,sede_id:8,es_prueba:true};
 for(const audience of [null,{role:{rol:'jugador'}},{role:{rol:'admin_club',sede_id:7}}])assert.equal(canReadQaCatalogRow(event,audience),false);
 assert.equal(canReadQaCatalogRow(event,{role:{rol:'super_admin'}}),true);
 assert.equal(canReadQaCatalogRow(event,{role:{rol:'admin_club',sede_id:8}}),true);
 assert.equal(canReadQaCatalogRow({id:8,es_prueba:true},{role:{rol:'admin_club',sede_id:8}}),true);
 assert.equal(canReadQaCatalogRow({id:1},null),true);
 assert.equal(canReadQaCatalogRow({id:8,sede_id:null,es_prueba:true},{role:{rol:'admin_club',sede_id:8}}),false);
});
test('player catalog omits operational configuration without losing booking prices/court catalog',()=>{
 assert.deepEqual(pickPlayerSedeSummary({id:7,precio_60min:0,deportes_disponibles:['padbol'],mercadopago_configurado:true,stripe_configurado:true,pago_manual_instrucciones:'private',surge_precio_minimo:12,surge_precio_maximo:50,es_prueba:false}),{id:7,precio_60min:0,deportes_disponibles:['padbol']});
});
