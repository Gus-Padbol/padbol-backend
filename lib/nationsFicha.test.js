import test from 'node:test';
import assert from 'node:assert/strict';
import {readNationsFichaReadiness, readNationsEnrollmentReadiness} from './nationsFicha.js';

const USER = {id:'00000000-0000-4000-8000-0000000000a1', email:'u@example.invalid'};
const profile = {
  id: 1, user_id: USER.id, nombre: 'Nombre', apellido: 'Apellido', telefono: '11223344',
  email: USER.email, pais: 'IT', ciudad: 'Roma', nivel: '2da', lateralidad: 'Diestro', pierna_habil: 'derecha',
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

test('Naples requires identity/contact/document data but not hidden sporting profile fields',async()=>{
 const p={id:1,user_id:USER.id,nombre:'Nombre',apellido:'Apellido',pais:'IT',pierna_habil:'derecha'};
 const r=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(p,{}),user:USER});
 assert.equal(r.complete,false);
 assert.deepEqual(r.missing.sort(),['ciudad','telefono','fecha_nacimiento','tipo_documento','pais_documento','nacionalidad','numero_documento'].sort());
 assert.equal(JSON.stringify(r).includes('Nombre'),false);
});
test('Naples event context does not require, invent or overwrite general level/hand/position/gender/category',async()=>{
 const p={...profile,nivel:'',lateralidad:null,posicion_cancha:null};
 const i={...identity,genero:null,categoria_deportiva:''};
 const before=JSON.stringify({p,i});
 assert.deepEqual(await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(p,i),user:USER}),{complete:true,missing:[]});
 assert.equal(JSON.stringify({p,i}),before,'readiness cannot mutate saved own data');
 const general=await readNationsFichaReadiness({supabaseAdmin:fakeDb(p,i),user:USER});
 assert.deepEqual(general.missing.sort(),['nivel','lateralidad','posicion_cancha','genero','categoria_deportiva'].sort(),'general application requirements unchanged');
 for(const genero of ['masculino','femenino','otro','prefiero_no_decir']){
  const saved={...identity,genero,categoria_deportiva:'General saved category'};
  const previous=JSON.stringify(saved);
  assert.deepEqual(await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(p,saved),user:USER}),{complete:true,missing:[]});
  assert.equal(JSON.stringify(saved),previous);
 }
});
test('Naples still requires selected identity, city, contact, full document and fails closed on private reads',async()=>{
 for(const key of ['nombre','apellido','pais','ciudad']){
  const r=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb({...profile,[key]:''},identity),user:USER});assert.ok(r.missing.includes(key));
 }
 for(const key of ['fecha_nacimiento','tipo_documento','pais_documento','nacionalidad']){
  const r=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(profile,{...identity,[key]:''}),user:USER});assert.ok(r.missing.includes(key));
 }
 const noContact=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb({...profile,telefono:'',whatsapp:''},{...identity,telefono:''}),user:USER});assert.ok(noContact.missing.includes('telefono'));
 assert.ok((await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(profile,{...identity,numero_documento_hash:null}),user:USER})).missing.includes('numero_documento'));
 const base=fakeDb();const db={from(table){const q=base.from(table);if(table==='jugadores_identidad')q.maybeSingle=async()=>({error:{message:'private unavailable'}});return q}};
 await assert.rejects(readNationsEnrollmentReadiness({supabaseAdmin:db,user:USER}));
 await assert.rejects(readNationsEnrollmentReadiness({supabaseAdmin:db,user:null}),{status:503});
});

test('Naples requires an explicit preferred foot and never reuses the hand field',async()=>{
 const noFoot={...profile,pierna_habil:''};
 let r=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(noFoot,identity),user:USER});
 assert.ok(r.missing.includes('pierna_habil'));
 const handOnly={...profile,lateralidad:'Diestro',pierna_habil:''};
 r=await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(handOnly,identity),user:USER});
 assert.ok(r.missing.includes('pierna_habil'));
 const footOnly={...profile,lateralidad:'',pierna_habil:'ambas'};
 assert.deepEqual(await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb(footOnly,identity),user:USER}),{complete:true,missing:[]});
 for(const value of ['derecha','izquierda','ambas']){
  assert.deepEqual(await readNationsEnrollmentReadiness({supabaseAdmin:fakeDb({...profile,pierna_habil:value},identity),user:USER}),{complete:true,missing:[]});
 }
});
