// Requires isolated embedded-postgres installation; no application database is used.
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
if (!process.env.PADBOL_EMBEDDED_POSTGRES_MODULE) throw Error('Set PADBOL_EMBEDDED_POSTGRES_MODULE to the absolute module path.');
const { default: EmbeddedPostgres } = await import(pathToFileURL(process.env.PADBOL_EMBEDDED_POSTGRES_MODULE));
const socket = createServer();
await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const dir = await mkdtemp(join(tmpdir(), 'padbol-whatsapp-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: join(dir,'data'), user:'postgres', password:'fixture-only', port, persistent:true, postgresFlags:['-h','127.0.0.1'], onLog:()=>{}, onError:()=>{} });
let started = false;
const clients=[];
try {
  await pg.initialise();await pg.start();started=true;
  for(let i=0;i<3;i++){const c=pg.getPgClient();await c.connect();clients.push(c);}
  const [setup, first, second]=clients;
  await setup.query(`create role anon; create role authenticated; create role service_role; create table public.crm_conversations(id uuid primary key,source_channel text not null); create table public.crm_replies(id uuid primary key,conversation_id uuid not null references public.crm_conversations,body text,operador text,status text); insert into crm_conversations values ('11111111-1111-4111-8111-111111111111','whatsapp'); insert into crm_replies values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111','draft','crm_funnel','pending');`);
  await setup.query(await readFile('sql/20261020000000_crm_whatsapp_manual_claim.sql','utf8'));
  const sql='select crm_claim_whatsapp_reply($1,$2,$3,$4) as result';
  const conv='11111111-1111-4111-8111-111111111111';
  await first.query('begin');
  const a=await first.query(sql,['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',conv,'first','operator']);
  assert.equal(a.rows[0].result.created,true);
  let settled=false;
  const other=second.query(sql,['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',conv,'second','operator']).then(r=>{settled=true;return r});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(settled,false,'second connection must wait for the conversation lock');
  await first.query('commit');
  assert.equal((await other).rows[0].result.blocked,true);
  assert.equal((await setup.query('select count(*)::int as n from crm_whatsapp_manual_attempts')).rows[0].n,1);
  console.log('PostgreSQL independent connections: lock, draft coexistence, and pending blocker passed');
} finally {
  for(const c of clients) await c.end().catch(()=>{});
  if(started) await pg.stop().catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
