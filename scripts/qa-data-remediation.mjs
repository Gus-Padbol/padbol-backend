#!/usr/bin/env node
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  findSedeDuplicateCandidates, findDurationDuplicateCandidates,
  findExpiredTournamentCandidates, findMembershipPlanCandidates, validateMutationRequest,
} from '../lib/adminDataRemediation.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};
const flag = (name) => args.includes(`--${name}`);
const finding = option('finding');
const apply = flag('apply');
const id = option('id');
const confirmId = option('confirm-id');
const table = option('table');
const fields = Object.fromEntries(args.filter((arg) => arg.startsWith('--set='))
  .map((arg) => arg.slice(6).split(/=(.*)/s).slice(0, 2)));

if (!finding) {
  console.error('Uso: --finding S-01|S-03|G-06|ME-01|T-02 [--apply --id ID --confirm-id ID --set=campo=valor]');
  process.exitCode = 2;
} else {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. No se realizó ninguna operación.');
    process.exitCode = 2;
  } else {
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const read = async (source, columns) => {
      const { data, error } = await db.from(source).select(columns);
      if (error) throw error;
      return data || [];
    };
    const detect = async () => {
      if (finding === 'S-01') return findSedeDuplicateCandidates(await read('sedes', 'id,nombre,ciudad,pais,activo'));
      if (finding === 'S-03') return findDurationDuplicateCandidates(await read('sedes_duraciones', 'id,sede_id,duracion_minutos,deporte,precio,activo'));
      if (finding === 'ME-01') {
        const [plans, sedes] = await Promise.all([
          read('membresia_planes', 'id,sede_id,nombre,descripcion,moneda,activo,vigencia_hasta'),
          read('sedes', 'id,pais'),
        ]);
        const countries = new Map(sedes.map((row) => [String(row.id), row.pais]));
        return findMembershipPlanCandidates(plans.map((row) => ({
          ...row, sede_pais: countries.get(String(row.sede_id)) || null,
        })));
      }
      if (finding === 'T-02') return findExpiredTournamentCandidates(await read('torneos', 'id,nombre,estado,fecha_inicio,fecha_fin'));
      if (finding === 'G-06') {
        const sources = [
          ['sedes', 'id,nombre'], ['torneos', 'id,nombre'],
          ['crm_conversations', 'id,subject,status'], ['padcoins_movimientos', 'id,concepto'],
          ['padcoins_premios', 'id,nombre'],
        ];
        const output = [];
        for (const [source, columns] of sources) {
          try {
            const rows = await read(source, columns);
            output.push({ table: source, candidates: rows.filter((row) => /demo|test|qa|e2e|ephemeral|no contactar/i.test(JSON.stringify(row))) });
          } catch (error) { output.push({ table: source, unavailable: error.code || 'read_failed' }); }
        }
        return output;
      }
      throw new Error('finding_no_soportado');
    };

    try {
      if (!apply) {
        console.log(JSON.stringify({ mode: 'dry-run', finding, candidates: await detect() }, null, 2));
      } else {
        const mutation = validateMutationRequest({ finding, id, confirmId, fields, deleteRow: flag('delete') });
        if (!mutation.ok) throw new Error(mutation.error);
        const source = finding === 'G-06' ? table : ({ 'S-03': 'sedes_duraciones', 'ME-01': 'membresia_planes', 'T-02': 'torneos' })[finding];
        if (!source || (finding === 'G-06' && !['sedes', 'torneos', 'crm_conversations', 'padcoins_movimientos', 'padcoins_premios'].includes(source))) {
          throw new Error('tabla_explicita_no_permitida');
        }
        const query = mutation.deleteRow ? db.from(source).delete() : db.from(source).update(mutation.fields);
        const { data, error } = await query.eq('id', id).select('id');
        if (error) throw error;
        console.log(JSON.stringify({ mode: 'apply', finding, table: source, id, affected: data?.length || 0 }, null, 2));
      }
    } catch (error) {
      console.error(JSON.stringify({ ok: false, finding, error: error.code || error.message }));
      process.exitCode = 1;
    }
  }
}
