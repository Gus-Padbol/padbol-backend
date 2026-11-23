// LOCAL ONLY. Actual HTTP route + PostgreSQL, synthetic Auth, exact supplied metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
const BEFORE=process.env.ALTAS004_BEFORE==='1';
const {mountCommercialReleaseRoutes}=await import('./commercialRelease.js');
const quoteIdent=name=>{assert.match(name,/^[a-z_][a-z0-9_]*$/);return '"'+name+'"';};
const BOOTSTRAP_SQL="\nCREATE ROLE anon NOLOGIN;\nCREATE ROLE authenticated NOLOGIN;\nCREATE ROLE service_role NOLOGIN BYPASSRLS;\n\nCREATE SCHEMA auth;\nCREATE TABLE auth.users (id uuid PRIMARY KEY, email text);\n\nCREATE TABLE public.organizaciones (id uuid PRIMARY KEY DEFAULT gen_random_uuid());\n\nCREATE TABLE public.sedes (\n  id bigserial PRIMARY KEY,\n  nombre text NOT NULL,\n  pais text NOT NULL,\n  ciudad text NOT NULL,\n  idioma text NOT NULL DEFAULT 'es',\n  cantidad_canchas integer,\n  horario_apertura text,\n  horario_cierre text,\n  duracion_reserva_minutos integer NOT NULL DEFAULT 90,\n  precio_por_reserva integer,\n  moneda text NOT NULL DEFAULT 'ARS',\n  estado text NOT NULL DEFAULT 'activo',\n  google_maps_url text,\n  google_maps_lat numeric,\n  google_maps_lng numeric,\n  imagen_portada text,\n  descripcion_corta text,\n  whatsapp_contacto text,\n  email_contacto text,\n  zona_horaria text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',\n  created_at timestamp without time zone DEFAULT now(),\n  updated_at timestamp without time zone DEFAULT now(),\n  direccion text,\n  telefono text,\n  precio_turno numeric,\n  numero_licencia text,\n  fecha_licencia date,\n  licencia_activa boolean DEFAULT true,\n  logo_url text,\n  fotos_urls jsonb DEFAULT '[]'::jsonb,\n  descripcion text,\n  mp_access_token text,\n  latitud numeric,\n  longitud numeric,\n  instagram text,\n  facebook text,\n  tiktok text,\n  twitter text,\n  youtube text,\n  website text,\n  precio_manana numeric,\n  precio_tarde numeric,\n  color_nombre text,\n  color_fondo_logo text DEFAULT '#000000',\n  franjas_horarias jsonb DEFAULT '[]'::jsonb,\n  fotos_destacadas jsonb DEFAULT '[]'::jsonb,\n  color_hero_primario text DEFAULT '#4C1D95',\n  color_hero_secundario text DEFAULT '#7C3AED',\n  color_borde_hero text DEFAULT '#6D28D9',\n  provincia text,\n  historia text,\n  metodo_pago text DEFAULT 'mercadopago',\n  stripe_account_id text,\n  pago_manual_instrucciones text,\n  stripe_customer_id text,\n  stripe_subscription_id text,\n  suscripcion_estado text,\n  suscripcion_proximo_cobro timestamp with time zone,\n  timezone text DEFAULT 'America/Argentina/Buenos_Aires',\n  anio_fundacion integer,\n  tipo_licencia text DEFAULT 'club_afiliado',\n  mp_public_key text,\n  slogan text,\n  amenities jsonb DEFAULT '[]'::jsonb,\n  precio_60min integer,\n  precio_90min integer,\n  precio_120min integer,\n  foto_portada text,\n  surge_activo boolean DEFAULT false,\n  surge_precio_minimo integer,\n  surge_precio_maximo integer,\n  foto_url text,\n  deportes_disponibles text[] DEFAULT ARRAY['padbol'::text],\n  es_prueba boolean NOT NULL DEFAULT false,\n  tipo_sede text NOT NULL DEFAULT 'reservable',\n  CONSTRAINT sedes_anio_fundacion_check CHECK (anio_fundacion IS NULL OR (anio_fundacion >= 1800 AND anio_fundacion <= 2100)),\n  CONSTRAINT sedes_metodo_pago_check CHECK (metodo_pago = ANY (ARRAY['mercadopago'::text, 'stripe'::text, 'manual'::text, 'efectivo'::text])),\n  CONSTRAINT sedes_reserva_completa_si_reservable CHECK (tipo_sede = 'torneo'::text OR (cantidad_canchas IS NOT NULL AND horario_apertura IS NOT NULL AND horario_cierre IS NOT NULL AND precio_por_reserva IS NOT NULL AND whatsapp_contacto IS NOT NULL)),\n  CONSTRAINT sedes_tipo_sede_valido CHECK (tipo_sede = ANY (ARRAY['reservable'::text, 'torneo'::text]))\n);\n\nCREATE TABLE public.canchas_por_deporte (\n  id serial PRIMARY KEY,\n  sede_id integer REFERENCES public.sedes(id) ON DELETE CASCADE,\n  deporte text NOT NULL,\n  cantidad integer NOT NULL DEFAULT 1,\n  activo boolean DEFAULT true,\n  created_at timestamp with time zone DEFAULT now()\n);\n\nCREATE TABLE public.user_roles (\n  id bigserial PRIMARY KEY,\n  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,\n  role text NOT NULL,\n  pais text,\n  sede_id bigint REFERENCES public.sedes(id),\n  created_at timestamp without time zone DEFAULT now(),\n  email text,\n  nombre text,\n  torneos_oficiales_habilitados boolean DEFAULT false,\n  alcance text DEFAULT 'sede',\n  ciudad text,\n  provincia text,\n  organizacion_id uuid REFERENCES public.organizaciones(id) ON DELETE SET NULL,\n  CONSTRAINT user_roles_role_check CHECK (role = ANY (ARRAY['super_admin'::text, 'admin_nacional'::text, 'admin_club'::text, 'empleado'::text, 'editor_contenido'::text]))\n);\n\nCREATE TABLE public.invitaciones_admin (\n  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n  email text NOT NULL,\n  token text NOT NULL,\n  pais text NOT NULL,\n  nombre_club text,\n  estado text NOT NULL DEFAULT 'pendiente',\n  created_at timestamp with time zone NOT NULL DEFAULT now(),\n  expires_at timestamp with time zone NOT NULL,\n  sede_id bigint REFERENCES public.sedes(id) ON DELETE SET NULL,\n  invited_role text NOT NULL DEFAULT 'admin_club',\n  invited_alcance text,\n  provincia text,\n  ciudad text,\n  organizacion_id uuid REFERENCES public.organizaciones(id) ON DELETE SET NULL,\n  CONSTRAINT invitaciones_admin_estado_check CHECK (estado = ANY (ARRAY['pendiente'::text, 'completada'::text, 'expirada'::text, 'cancelada'::text])),\n  CONSTRAINT invitaciones_admin_token_key UNIQUE (token)\n);\n\nALTER TABLE public.sedes ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.canchas_por_deporte ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.invitaciones_admin ENABLE ROW LEVEL SECURITY;\n\n-- Metadata s\u00f3lo trae el CREATE TRIGGER, no el cuerpo de la funci\u00f3n. Se replica\n-- con un stub que deja pasar el INSERT del alta (mismo criterio del verify).\nCREATE OR REPLACE FUNCTION public.protect_torneo_qa_marker()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'public'\nAS $function$\nBEGIN\n  IF (TG_OP = 'INSERT' AND NEW.es_prueba)\n     OR (TG_OP = 'UPDATE' AND NEW.es_prueba IS DISTINCT FROM OLD.es_prueba) THEN\n    IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN\n      RAISE EXCEPTION 'The QA tournament marker is managed by the service only'\n        USING ERRCODE = '42501';\n    END IF;\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n;\nCREATE TRIGGER protect_sede_qa_marker\n  BEFORE INSERT OR UPDATE OF es_prueba ON public.sedes\n  FOR EACH ROW EXECUTE FUNCTION public.protect_torneo_qa_marker();\n\nGRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;\nGRANT SELECT, INSERT, UPDATE, DELETE ON public.sedes, public.canchas_por_deporte,\n  public.user_roles, public.invitaciones_admin TO service_role;\nGRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;\nCREATE TABLE public.sedes_pendientes (id bigserial NOT NULL,created_at timestamp with time zone DEFAULT now(),created_by text,estado text DEFAULT 'pendiente'::text,motivo_rechazo text,nombre text NOT NULL,direccion text,ciudad text,pais text,latitud numeric,longitud numeric,horario_apertura text,horario_cierre text,precio_base numeric,moneda text DEFAULT 'ARS'::text,whatsapp text,email_contacto text,numero_licencia text,fecha_contrato date,tipo_licencia text DEFAULT 'club_afiliado'::text,licenciatario_nombre text,licenciatario_email text,licenciatario_telefono text,licenciatario_pais text,provincia text,organizacion_id uuid,cantidad_canchas_solicitadas integer,CONSTRAINT sedes_pendientes_cantidad_canchas_solicitadas_check CHECK (((cantidad_canchas_solicitadas IS NULL) OR (cantidad_canchas_solicitadas > 0))),CONSTRAINT sedes_pendientes_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE SET NULL,CONSTRAINT sedes_pendientes_pkey PRIMARY KEY (id));\nALTER TABLE public.sedes_pendientes ENABLE ROW LEVEL SECURITY;\nGRANT ALL ON public.sedes_pendientes TO service_role;\nCREATE TABLE public.organizacion_sedes (organizacion_id uuid NOT NULL,sede_id bigint NOT NULL,created_at timestamp with time zone NOT NULL DEFAULT now(),CONSTRAINT organizacion_sedes_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE CASCADE,CONSTRAINT organizacion_sedes_pkey PRIMARY KEY (organizacion_id, sede_id),CONSTRAINT organizacion_sedes_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE,CONSTRAINT organizacion_sedes_sede_unica UNIQUE (sede_id));\nALTER TABLE public.organizacion_sedes ENABLE ROW LEVEL SECURITY;\nGRANT ALL ON public.organizacion_sedes TO service_role;\nCREATE TABLE jugadores_perfil(id bigserial PRIMARY KEY,email text,whatsapp text); GRANT ALL ON jugadores_perfil TO service_role; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;";
function createSupabaseAdapter(pool, options = {}) {
  const state = {
    authCalls: 0,
    deliveries: 0,
    writes: [],
    lastAuthEmail: null,
    authMode: options.authMode || 'existing',
    outbound: options.outbound === true,
  };
  const allowed = new Set(['invitaciones_admin', 'sedes', 'canchas_por_deporte', 'user_roles', 'sedes_pendientes', 'organizacion_sedes', 'jugadores_perfil']);

  async function runAsService(sql, params = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE service_role');
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transacción ya abortada */ }
      throw error;
    } finally {
      client.release();
    }
  }

  const supabase = {
    auth: {
      admin: {
        createUser: async (credentials = {}) => {
          state.authCalls += 1;
          if(options.afterAuth)await options.afterAuth();
          state.lastAuthEmail = String(credentials.email || '').trim().toLowerCase();
          if (state.authMode === 'unavailable') {
            return { data: { user: null }, error: { status: 503, message: 'Fixture Auth temporalmente no disponible' } };
          }
          if (state.authMode === 'new') {
            return { data: { user: { id: '00000000-0000-4000-8000-000000000003', email: state.lastAuthEmail } }, error: null };
          }
          return { data: { user: null }, error: { status: 422, code: 'user_already_exists', message: 'Fixture account exists' } };
        },
      },
      resetPasswordForEmail: async (email) => {
        state.deliveries += 1;
        state.lastAuthEmail = String(email || '').trim().toLowerCase();
        return { data: {}, error: null };
      },
    },

    from(table) {
      if (!allowed.has(table)) throw new Error(`Tabla inesperada en from(): ${table}`);
      const filters = [];
      let mode = 'select';
      let values = null;
      let single = false;
      let limitN = null;
      let orderBy = null;

      const whereSql = (params) => filters.map((filter) => {
        if (filter.op === 'is') {
          if (filter.value === null) return `${quoteIdent(filter.key)} IS NULL`;
          params.push(filter.value);
          return `${quoteIdent(filter.key)} IS $${params.length}`;
        }
        if (filter.op === 'in') {
          params.push(filter.value);
          return `${quoteIdent(filter.key)} = ANY($${params.length})`;
        }
        params.push(filter.value);
        return `${quoteIdent(filter.key)} ${filter.op === 'neq' ? '<>' : '='} $${params.length}`;
      }).join(' AND ');

      const query = {
        select() { return query; },
        eq(key, value) { filters.push({ op: 'eq', key, value }); return query; },
        neq(key, value) { filters.push({ op: 'neq', key, value }); return query; },
        is(key, value) { filters.push({ op: 'is', key, value }); return query; },
        in(key, value) { filters.push({ op: 'in', key, value }); return query; },
        order(key, opts = {}) { orderBy = { key, dir: opts.ascending === false ? 'DESC' : 'ASC' }; return query; },
        limit(n) { limitN = n; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        insert(payload) { mode = 'insert'; values = Array.isArray(payload) ? payload : [payload]; return query; },
        update(payload) { mode = 'update'; values = payload; return query; },
        delete() { mode = 'delete'; return query; },
        async then(resolve, reject) {
          try {
            let rows;
            if (mode === 'insert') {
              rows = [];
              for (const row of values) {
                const params = [];
                const cols = Object.keys(row);
                const placeholders = cols.map((key) => { params.push(row[key]); return `$${params.length}`; });
                const result = await runAsService(
                  `INSERT INTO public.${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')})
                   VALUES (${placeholders.join(', ')}) RETURNING *`, params,
                );
                rows.push(result.rows[0]);
              }
              state.writes.push({ table, mode });
            } else if (mode === 'update') {
              const params = [];
              const where = whereSql(params);
              const cols = Object.keys(values);
              const sets = cols.map((key) => { params.push(values[key]); return `${quoteIdent(key)} = $${params.length}`; });
              const result = await runAsService(
                `UPDATE public.${quoteIdent(table)} SET ${sets.join(', ')}${where ? ` WHERE ${where}` : ''} RETURNING *`, params,
              );
              rows = result.rows;
              state.writes.push({ table, mode });
            } else if (mode === 'delete') {
              const params = [];
              const where = whereSql(params);
              const result = await runAsService(
                `DELETE FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''} RETURNING *`, params,
              );
              rows = result.rows;
              state.writes.push({ table, mode });
            } else {
              const params = [];
              const where = whereSql(params);
              const suffix = orderBy ? ` ORDER BY ${quoteIdent(orderBy.key)} ${orderBy.dir}` : '';
              const limitSql = limitN != null ? ` LIMIT ${Number(limitN)}` : '';
              const result = await runAsService(
                `SELECT to_jsonb(_pg_row) AS value FROM (SELECT * FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}${suffix}${limitSql}) _pg_row`, params,
              );
              // PostgreSQL serializes numeric JSON values; pg JSON parser returns JS numbers,
              // matching PostgREST transport rather than pg's NUMERIC string parser.
              rows = result.rows.map(row=>row.value);
              if(table==='sedes_pendientes' && options.readBarrier)await options.readBarrier();
            }
            return resolve({ data: single ? rows[0] ?? null : rows, error: null });
          } catch (error) {
            return reject(error);
          }
        },
      };
      return query;
    },

    async rpc(name, params = {}) {
      if(name==='aprobar_sede_pendiente_atomica'){
        try{ const result=await runAsService('SELECT public.aprobar_sede_pendiente_atomica($1::bigint,$2::uuid,$3::jsonb,$4::jsonb) out',[params.p_request_id,params.p_actor_id,JSON.stringify(params.p_expected),JSON.stringify(params.p_sede)]);return {data:result.rows[0].out,error:null}; }catch(e){console.log('LOCAL_RPC_ERROR',e.code,e.message);return {data:null,error:{code:e.code,message:e.message}};}
      }
      if (name !== 'completar_invitacion_club_atomica') {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${name}` } };
      }
      try {
        const result = await runAsService(
          `SELECT public.completar_invitacion_club_atomica($1::text, $2::text, $3::text, $4::jsonb, $5::jsonb) AS out`,
          [params.p_token ?? null, params.p_email ?? null, params.p_nombre_admin ?? null,
            JSON.stringify(params.p_sede ?? null), JSON.stringify(params.p_deportes ?? null)],
        );
        return { data: result.rows[0].out, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code, message: error.message, details: error.detail } };
      }
    },
  };
  return { state, supabase };
}


const ACTOR='11111111-1111-4111-8111-111111111111';
const ORG='22222222-2222-4222-8222-222222222222';
const EMAIL='organizer@fixture.invalid';
const SQL_FILE=new URL('../sql/candidates/20261123_sede_pending_approval_atomic.sql',import.meta.url);

test('pending approval: actual HTTP+PG concurrent/retry/rollback and authorization', {timeout:60000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'altas004-'));let started=false,pool,admin;
 const env={PATH:process.env.PATH,LC_ALL:'C'};
 const run=(cmd,args)=>execFileSync(cmd,args,{env,encoding:'utf8',stdio:'pipe'});
 const data=path.join(dir,'data'),port=30000+Math.floor(Math.random()*20000);
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);started=true;
  pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres'});admin=await pool.connect();
  await admin.query(BOOTSTRAP_SQL);
  if(!BEFORE)await admin.query(fs.readFileSync(SQL_FILE,'utf8'));
  const reset=async()=>{
   await admin.query('DROP TRIGGER IF EXISTS injected_pending_fail ON sedes_pendientes; DROP FUNCTION IF EXISTS injected_pending_fail(); TRUNCATE sedes,sedes_pendientes,user_roles,organizacion_sedes,organizaciones,auth.users RESTART IDENTITY CASCADE');
   await admin.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[ACTOR,'super@fixture.invalid']);
   await admin.query("INSERT INTO user_roles(user_id,email,role) VALUES($1,'super@fixture.invalid','super_admin')",[ACTOR]);
   await admin.query('INSERT INTO organizaciones(id) VALUES($1)',[ORG]);
   await admin.query(`INSERT INTO sedes_pendientes(id,nombre,pais,ciudad,direccion,horario_apertura,horario_cierre,precio_base,cantidad_canchas_solicitadas,whatsapp,email_contacto,licenciatario_email,licenciatario_nombre,organizacion_id,created_by)
    VALUES(7,'Synthetic club','Argentina','Rosario','Synthetic street','09:00','22:00',100,2,'+5493415550000','club@fixture.invalid',$1,'Synthetic owner',$2,'creator@fixture.invalid')`,[EMAIL,ORG]);
  };
  const counts=async()=>(await admin.query(`SELECT (SELECT count(*)::int FROM sedes) venues,(SELECT count(*)::int FROM organizacion_sedes) links,(SELECT count(*)::int FROM user_roles WHERE email=$1) roles,(SELECT estado FROM sedes_pendientes WHERE id=7) state`,[EMAIL])).rows[0];
  async function server(opts={}){
   const adapter=createSupabaseAdapter(pool,opts);if(opts.noRpc)delete adapter.supabase.rpc;
   const app=express();app.use(express.json());
   mountCommercialReleaseRoutes(app,{supabaseAdmin:adapter.supabase,runtime:{outboundDeliveryEnabled:false},authUserFromBearer:async()=>opts.noUser?null:{id:ACTOR,email:'super@fixture.invalid'},assertSuperAdminReq:async()=>{},adminListScopeFromRequest:async()=>({superA:true}),sedesPermitidasPorScope:async()=>({sedes:[]})});
   const srv=app.listen(0,'127.0.0.1');await once(srv,'listening');
   return {state:adapter.state,async request(){const r=await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/sedes-pendientes/7/aprobar`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return {status:r.status,body:await r.json()};},close:()=>new Promise(resolve=>{srv.close(resolve);srv.closeAllConnections?.();})};
  }
  await reset();let reached=0,release;const barrier=new Promise(r=>release=r);
  const s=await server({readBarrier:async()=>{if(++reached===2)release();await barrier;}});
  let responses;try{responses=await Promise.all([s.request(),s.request()]);}finally{await s.close();}
  const concurrent=await counts();console.log('CONCURRENT',JSON.stringify({statuses:responses.map(x=>x.status),counts:concurrent}));
  if(BEFORE){assert.equal(concurrent.venues,2);assert.equal(concurrent.links,2);}else{
   assert.deepEqual(responses.map(x=>x.status).sort(),[200,400]);assert.deepEqual(concurrent,{venues:1,links:1,roles:1,state:'aprobada'});
  }
  await reset();await admin.query(`CREATE FUNCTION injected_pending_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'INJECTED_AFTER_ROLE_BEFORE_PENDING'; END$$; CREATE TRIGGER injected_pending_fail BEFORE UPDATE ON sedes_pendientes FOR EACH ROW EXECUTE FUNCTION injected_pending_fail()`);
  const recovery=await server();try{
   const failed=await recovery.request();assert.equal(failed.status,500);
   const partial=await counts();console.log('AFTER_FAILURE',JSON.stringify(partial));
   assert.deepEqual(partial,BEFORE?{venues:1,links:1,roles:1,state:'pendiente'}:{venues:0,links:0,roles:0,state:'pendiente'});
   await admin.query('DROP TRIGGER injected_pending_fail ON sedes_pendientes');
   const retried=await recovery.request();assert.equal(retried.status,200);
   const final=await counts();assert.equal(final.venues,BEFORE?2:1);assert.equal(final.links,BEFORE?2:1);assert.equal(final.roles,1);assert.equal(final.state,'aprobada');
   assert.equal((await recovery.request()).status,400);assert.deepEqual(await counts(),final);
   assert.equal(recovery.state.deliveries,0);console.log('RETRY_REPLAY',JSON.stringify(final));
  }finally{await recovery.close();}
  if(BEFORE)return;
  await reset();const unavailable=await server({noRpc:true});try{assert.equal((await unavailable.request()).status,503);assert.deepEqual(await counts(),{venues:0,links:0,roles:0,state:'pendiente'});}finally{await unavailable.close();}
  await reset();const authFail=await server({authMode:'unavailable'});try{assert.equal((await authFail.request()).status,503);assert.deepEqual(await counts(),{venues:0,links:0,roles:0,state:'pendiente'});}finally{await authFail.close();}
  const noUser=await server({noUser:true});try{assert.equal((await noUser.request()).status,401);assert.equal(noUser.state.authCalls,0);}finally{await noUser.close();}
  // Preserve chain owner: approval links venue but never demotes/reassigns its role.
  await reset();await admin.query('UPDATE sedes_pendientes SET created_by=$1 WHERE id=7',[EMAIL]);
  await admin.query("INSERT INTO user_roles(email,role,alcance,pais) VALUES($1,'admin_nacional','pais','Argentina')",[EMAIL]);
  const chain=await server();try{assert.equal((await chain.request()).status,200);assert.equal((await admin.query('SELECT role FROM user_roles WHERE email=$1',[EMAIL])).rows[0].role,'admin_nacional');assert.equal((await counts()).links,1);}finally{await chain.close();}
  await reset();await admin.query("UPDATE sedes_pendientes SET precio_base=NUMERIC '100.00',latitud=NUMERIC '-34.5000',longitud=NUMERIC '-58.4500' WHERE id=7");
  const numeric=await server();try{
   const response=await numeric.request();
   console.log('NUMERIC_JSON_ROUNDTRIP',JSON.stringify({status:response.status,counts:await counts()}));
   assert.equal(response.status,process.env.ALTAS004_NUMERIC_REPRO==='1'?409:200);
   if(process.env.ALTAS004_NUMERIC_REPRO==='1'){assert.equal((await counts()).venues,0);return;}
   const stored=(await admin.query('SELECT precio_turno::text price,latitud::text lat,longitud::text lon FROM sedes')).rows[0];
   assert.deepEqual(stored,{price:'100',lat:'-34.5',lon:'-58.45'});
  }finally{await numeric.close();}
  await reset();await admin.query("UPDATE sedes_pendientes SET precio_base=NUMERIC '100.00',latitud=NUMERIC '-34.5000',longitud=NUMERIC '-58.4500' WHERE id=7");
  const changedNumeric=await server({afterAuth:()=>admin.query('UPDATE sedes_pendientes SET precio_base=101 WHERE id=7')});
  try{assert.equal((await changedNumeric.request()).status,409);assert.equal((await counts()).venues,0);console.log('PASS REAL_PRICE_CHANGE_100_TO_101_REJECTED');}finally{await changedNumeric.close();}
  await reset();const changedTerritory=await server({afterAuth:()=>admin.query("UPDATE sedes_pendientes SET provincia='Changed province' WHERE id=7")});
  try{assert.equal((await changedTerritory.request()).status,409);assert.equal((await counts()).venues,0);console.log('PASS REAL_TERRITORY_CHANGE_REJECTED');}finally{await changedTerritory.close();}
  await reset();const stale=await server({afterAuth:()=>admin.query("UPDATE sedes_pendientes SET nombre='Changed while Auth pending' WHERE id=7")});
  try{const result=await stale.request();assert.equal(result.status,409);assert.equal(result.body.code,'SEDE_APPROVAL_CHANGED_RETRY');assert.equal((await counts()).venues,0);}finally{await stale.close();}
  await reset();const revoked=await server({afterAuth:()=>admin.query("UPDATE user_roles SET role='admin_club' WHERE user_id=$1",[ACTOR])});
  try{assert.equal((await revoked.request()).status,403);assert.equal((await counts()).venues,0);}finally{await revoked.close();}
  await reset();await admin.query("UPDATE sedes_pendientes SET tipo_licencia='master_provincia',provincia='Santa Fe' WHERE id=7");
  const territory=await server();try{assert.equal((await territory.request()).status,200);const role=(await admin.query('SELECT role,alcance,provincia,pais,sede_id FROM user_roles WHERE email=$1',[EMAIL])).rows[0];assert.deepEqual(role,{role:'admin_nacional',alcance:'provincia',provincia:'Santa Fe',pais:'Argentina',sede_id:null});}finally{await territory.close();}
  await admin.query(fs.readFileSync(new URL('../sql/candidates/20261123_sede_pending_approval_atomic.verify-readonly.sql',import.meta.url),'utf8'));
  for(const role of ['anon','authenticated']){
   await admin.query('BEGIN');await admin.query(`SET LOCAL ROLE ${role}`);
   await assert.rejects(admin.query("SELECT aprobar_sede_pendiente_atomica(7,$1,'{}'::jsonb,'{}'::jsonb)",[ACTOR]),e=>e.code==='42501');await admin.query('ROLLBACK');
  }
  console.log('PASS ATOMIC_CONCURRENCY_ROLLBACK_RETRY_AUTH_MISSING_RPC_CHAIN_ACL');
 }finally{
  admin?.release();await pool?.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  assert.ok(dir.startsWith(path.join(os.tmpdir(),'altas004-')));fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_PG');
 }
});
