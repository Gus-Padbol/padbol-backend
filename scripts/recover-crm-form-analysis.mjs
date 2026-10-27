#!/usr/bin/env node
import 'dotenv/config';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createCrmService, createSupabaseCrmRepository } from '../lib/crmService.js';
import { createCrmLeadAutoAnalyzer } from '../lib/crmLeadAutoAnalysis.js';
import { recoverFormAnalysis } from '../lib/crmAnalysisRecovery.js';

const args = process.argv.slice(2);
const allowedIds = args.filter(arg => arg.startsWith('--id=')).map(arg => arg.slice(5));
if (!allowedIds.length || allowedIds.length > 20 || allowedIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
  throw new Error('Provide 1–20 explicit conversation UUIDs as --id=UUID. Default is dry run; use --apply to recover.');
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, realtime: { transport: WebSocket } });
const repository = createSupabaseCrmRepository(db);
const analyzer = createCrmLeadAutoAnalyzer({ crmService: createCrmService({ repository }) });
const { data, error } = await db.from('crm_conversations').select('*, contact:crm_contacts(nombre,email_normalized,phone_normalized)').in('id', allowedIds);
if (error) throw error;
for (const row of data || []) {
  const source = await db.from('crm_conversations').select('id').eq('source_ref', row.source_ref);
  if (source.error) throw source.error;
  if (source.data?.length !== 1 || source.data[0].id !== row.id) throw new Error('CRM_ANALYSIS_SOURCE_AMBIGUOUS');
  const result = await recoverFormAnalysis({ row, allowedIds, repository, analyzer, apply: args.includes('--apply') });
  console.log(JSON.stringify({ ...result, ticket: row.ticket_reference || row.ticket_number || null, name: row.contact?.nombre || null, form: row.qualification_data?.form_submission?.form || null }));
}
