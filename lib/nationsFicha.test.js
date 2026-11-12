import test from 'node:test';
import assert from 'node:assert/strict';
import {readNationsFichaReadiness, readNationsEnrollmentReadiness} from './nationsFicha.js';

const USER = {id:'00000000-0000-4000-8000-0000000000a1', email:'u@example.invalid'};
const profile = {
  id: 1, user_id: USER.id, nombre: 'Nombre', apellido: 'Apellido', telefono: '11223344',
  email: USER.email, pais: 'IT', ciudad: 'Roma', nivel: '2da', lateralidad: 'Diestro',
  posicion_cancha: 'reves', username: 'u', alias: 'u', foto_url: null,
};
const identity = {
  fecha_nacimiento: '1990-01-01', tipo_documento: 'dni', pais_documento: 'IT',
  numero_documento_cifrado: null, numero_documento_hash: 'hash', nacionalidad: 'IT',
  genero: 'masculino', categoria_deportiva: '2da', telefono: '11223344',
};
function fakeDb(p = profile, i = identity) {
  return {from(table) {
    const q = {
      select() { return q; }, eq() { return q; }, is() { return q; },
      limit() { return Promise.resolve({data: p ? [p] : [], error: null}); },
      maybeSingle() { return Promise.resolve({data: i, error: null}); },
    };
    if (table === 'jugadores_perfil') return q;
    if (table === 'jugadores_identidad') return q;
    throw new Error(`unexpected ${table}`);
  }};
}

test('ficha completa reutiliza datos guardados y no devuelve PII', async () => {
  const r = await readNationsFichaReadiness({supabaseAdmin: fakeDb(), user: USER});
  assert.deepEqual(r, {complete:true, missing:[]});
  assert.equal(JSON.stringify(r).includes('11223344'), false);
  assert.equal(JSON.stringify(r).includes(USER.email), false);
});

test('ficha incompleta enumera campos faltantes sin inventar valores', async () => {
  const r = await readNationsFichaReadiness({supabaseAdmin: fakeDb({...profile, ciudad:'', posicion_cancha:''}, {...identity, nacionalidad:'', categoria_deportiva:''}), user: USER});
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing.sort(), ['categoria_deportiva','ciudad','nacionalidad','posicion_cancha'].sort());
});

test('documento incompleto bloquea aunque existan datos básicos', async () => {
  const r = await readNationsFichaReadiness({supabaseAdmin: fakeDb(profile, {...identity, numero_documento_hash:null}), user: USER});
  assert.equal(r.complete, false);
  assert.ok(r.missing.includes('numero_documento'));
});

test('payload real de MiPerfil: whatsapp sin telefono + identidad/categoría completa', async () => {
  const p = {...profile, telefono:null, whatsapp:'11223344', posicion_cancha:'derecha'};
  const r = await readNationsFichaReadiness({supabaseAdmin: fakeDb(p, identity), user: USER});
  assert.equal(r.complete, true);
  const i = {...identity, telefono:''};
  const r2 = await readNationsFichaReadiness({supabaseAdmin: fakeDb({...p, whatsapp:''}, i), user: USER});
  assert.equal(r2.complete, false);
  assert.ok(r2.missing.includes('telefono'));
});

test('Naples complete ficha refuses four-field-only profiles and reuses the existing private completeness contract',async()=>{
 const p={id:1,user_id:USER.id,nombre:'Nombre',apellido:'Apellido',pais:'IT'};
 const r=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(p,{genero:'masculino'}),user:USER});
 assert.equal(r.complete,false);
 for(const key of ['ciudad','nivel','lateralidad','posicion_cancha','telefono','fecha_nacimiento','tipo_documento','pais_documento','nacionalidad','categoria_deportiva','numero_documento']) assert.ok(r.missing.includes(key),key);
 assert.ok(!r.missing.includes('nombre'));assert.ok(!r.missing.includes('pais'));
 assert.equal(JSON.stringify(r).includes('Nombre'),false);
});
test('Naples complete saved male/female ficha passes without re-entering identity and rejects non-sporting categories',async()=>{
 for(const genero of ['masculino','femenino'])assert.deepEqual(await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(profile,{...identity,genero}),user:USER}),{complete:true,missing:[]});
 for(const genero of ['',null,'otro','prefiero_no_decir','abierto'])assert.deepEqual(await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(profile,{...identity,genero}),user:USER}),{complete:false,missing:['genero']});
 assert.deepEqual(await readNationsFichaReadiness({supabaseAdmin:fakeDb(profile,{...identity,genero:'otro'}),user:USER}),{complete:true,missing:[]},'general profile policy is unchanged');
});
test('Naples gate requires complete document and fails closed on private identity read errors',async()=>{
 assert.ok((await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(profile,{...identity,numero_documento_hash:null}),user:USER})).missing.includes('numero_documento'));
 const base=fakeDb();const db={from(table){const q=base.from(table);if(table==='jugadores_identidad')q.maybeSingle=async()=>({error:{message:'private unavailable'}});return q}};
 await assert.rejects(readNationsEnrollmentReadiness({supabaseAdmin:db,user:USER}));
 await assert.rejects(readNationsEnrollmentReadiness({supabaseAdmin:db,user:null}),{status:503});
});
