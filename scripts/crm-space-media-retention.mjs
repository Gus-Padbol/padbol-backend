// No work runs merely by importing this script. Dry-run is the default invocation.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { cleanupExpiredSpaceMedia } from '../lib/crmSpacePrivacy.js';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--dry-run', '--apply'].includes(arg)) || args.includes('--apply') && args.includes('--dry-run')) throw new Error('Use --dry-run (default) or --apply.');
  const apply = args.includes('--apply');
  const allowDelete = env.CRM_SPACE_RETENTION_DELETE_ENABLED === 'true';
  if (apply && !allowDelete) throw new Error('Deletion requires CRM_SPACE_RETENTION_DELETE_ENABLED=true and --apply.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required; no automatic environment-file loading is performed.');
  if (apply && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error('Storage credentials are required for apply mode.');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const storage = apply ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).storage : null;
    const result = await cleanupExpiredSpaceMedia({ pool, storage, apply, allowDelete });
    console.log(JSON.stringify(result));
    return result;
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
