import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHubRouter } from './hub.js';

const rows=[
 {card_key:'torneos',imagen_url:'https://cdn.test/torneos.jpg'},
 {card_key:'torneos_acceso',imagen_url:'https://cdn.test/acceso.jpg'},
 {card_key:'rankings',imagen_url:null},
];
const supabaseAdmin={from:()=>({select:()=>({eq:async()=>({data:rows,error:null})})})};
const app=express();app.use(express.json());app.use('/api/hub',createHubRouter({supabaseAdmin}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
try{
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api/hub/imagenes?deporte=padbol`);assert.equal(r.status,200);const body=await r.json();
 assert.equal(body.torneos_acceso.image_url,'https://cdn.test/acceso.jpg');
 assert.equal(body.torneos.image_url,'https://cdn.test/torneos.jpg');
 assert.notEqual(body.torneos_acceso.image_url,body.torneos.image_url);
 assert.equal(body.rankings.image_url,null);
}finally{await new Promise(r=>server.close(r));}
