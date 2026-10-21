import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

test('paginación bigint y actualización por PK preservan perfiles sin usuario', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table jugadores_perfil (id bigint primary key, user_id uuid, email text, pendiente_validacion boolean, nivel text);
      insert into jugadores_perfil values (1,null,'same@example.test',true,'6ta'),(2,'00000000-0000-0000-0000-000000000002','same@example.test',true,'5ta'),(9007199254740993,null,null,true,'4ta');`);
    let last = '0'; const ids = [];
    for (;;) {
      const page = await db.query('select id::text as id from jugadores_perfil where pendiente_validacion = true and id > $1::bigint order by id limit 1',[last]);
      if (!page.rows.length) break;
      last = page.rows[0].id; ids.push(last);
    }
    assert.deepEqual(ids,['1','2','9007199254740993']);
    const updated = await db.query('update jugadores_perfil set pendiente_validacion=false, nivel=$1 where id=$2::bigint and pendiente_validacion=true returning id::text', ['3ra','1']);
    assert.deepEqual(updated.rows,[{id:'1'}]);
    assert.equal((await db.query('update jugadores_perfil set pendiente_validacion=false where id=1 and pendiente_validacion=true returning id')).rows.length,0);
    const untouched = await db.query('select pendiente_validacion,nivel from jugadores_perfil where id=2');
    assert.deepEqual(untouched.rows,[{pendiente_validacion:true,nivel:'5ta'}]);
  } finally { await db.close(); }
});
