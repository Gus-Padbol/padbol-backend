import test from 'node:test';
import assert from 'node:assert/strict';
import {readNationsFichaReadiness} from './nationsFicha.js';

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
      select() { return q; }, eq() { return q; },
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
