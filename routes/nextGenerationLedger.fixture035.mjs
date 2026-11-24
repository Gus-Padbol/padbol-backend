import fs from 'node:fs';
import express from 'express';
import { start } from '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/.worktrees/jefe12-cierres-backend029/lib/nextGenerationUuid026.fixture.mjs';
import { createNextGenerationLedgerRouter } from './nextGenerationLedger.js';

const DEFAULT_SQL = new URL('../sql/candidates/20261124_nextgen_ledger035.sql', import.meta.url);
const SQL = fs.readFileSync(DEFAULT_SQL, 'utf8');
const ACTOR = '00000000-0000-4000-8000-000000000901';
const CLUB = '00000000-0000-4000-8000-000000000902';
const VA = '00000000-0000-4000-8000-000000000101';
const VB = '00000000-0000-4000-8000-000000000102';
export const known = { actor: ACTOR, club: CLUB, requestA: VA, requestB: VB };

export async function startLedgerFixture({ sqlPath = null } = {}) {
  process.env.NEXTGEN_MANUAL_LEDGER_ENABLED = 'true';
  const sql = sqlPath ? fs.readFileSync(sqlPath, 'utf8') : SQL;
  const fx = await start({ install: false });
  try {
    await fx.pool.query(sql);
    await fx.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;");
    await fx.pool.query(`INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'super@fixture',now()),($2,'club@fixture',now())`, [ACTOR, CLUB]);
    await fx.pool.query(`INSERT INTO public.user_roles(user_id,role,email) VALUES($1,'super_admin','super@fixture'),($2,'admin_club','club@fixture')`, [ACTOR, CLUB]);
    await fx.pool.query(`UPDATE public.ng_solicitudes_sede SET estado='aprobada',canonical_sede_id=1 WHERE id=$1`, [VA]);
    await fx.pool.query(`UPDATE public.ng_solicitudes_sede SET estado='aprobada',canonical_sede_id=2 WHERE id=$1`, [VB]);
    const users = { super: ACTOR, club: CLUB };
    const roles = { [ACTOR]: { role: 'super_admin', sede_id: null }, [CLUB]: { role: 'admin_club', sede_id: 1 } };
    const app = express(); app.use(express.json());
    app.use('/api/admin/next-generation/cuentas', createNextGenerationLedgerRouter({
      pgPool: fx.pool,
      getAuthenticatedUser: async (req) => { const id = users[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return { user: id ? { id, email: id === ACTOR ? 'super@fixture' : 'club@fixture' } : null }; },
      fetchUserRoleRowForAuthUser: async (user) => roles[user.id] || null,
      legacySuperAdminEmails: [],
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, pool: fx.pool, known, tokens: { super: 'super', club: 'club' }, stop: async () => { await new Promise((r) => server.close(r)); await fx.stop(); } };
  } catch (error) { await fx.stop(); throw error; }
}
