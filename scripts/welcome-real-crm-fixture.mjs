// Test-only SQL transport: production createCrmService AND Supabase repository
// execute unchanged; this builder translates their narrow CRUD calls to PGlite.
// No contact matching, normalization, merge or idempotency logic lives here.
import {readFile} from 'node:fs/promises';
import {createCrmService,createSupabaseCrmRepository} from '../lib/crmService.js';
const TABLES=new Set(['crm_contacts','crm_channel_attempts','crm_conversations','crm_inbound_events']);
const ident=value=>{if(!/^[a-z_][a-z0-9_]*$/.test(value))throw Error('FIXTURE_IDENTIFIER_INVALID');return '"'+value+'"';};
export async function createCrmFixtureSchema(db){
 const source=await readFile(new URL('../sql/migrations/rpc_schema_real.sql',import.meta.url),'utf8');
 for(const table of TABLES){const pattern=new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`);const ddl=source.match(pattern)?.[0];if(!ddl)throw Error('ACTUAL_FIXTURE_SCHEMA_MISSING');await db.exec(ddl);}
 for(const table of TABLES){const lines=source.split('\n').filter(line=>line.startsWith(`alter table public.${table} add constraint `)&&(/ PRIMARY KEY | UNIQUE | CHECK /.test(line)));for(const line of lines)await db.exec(line);}
 // Production supplies ticket numbers through its SQL trigger; local fixture
 // substitutes only this unrelated numbering default, never contact identity.
 await db.exec("create sequence fixture_ticket;alter table crm_conversations alter column ticket_number set default nextval('fixture_ticket');");
}
export function realCrmService(db){
 const from=table=>{
  if(!TABLES.has(table))throw Error('FIXTURE_TABLE_FORBIDDEN');
  let op='select',payload,limit,shape='many';const filters=[];
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},limit(n){limit=n;return q;},insert(v){op='insert';payload=v;return q;},single(){shape='single';return execute();},maybeSingle(){shape='maybe';return execute();},then(ok,bad){return execute().then(ok,bad);}};
  async function execute(){
   try{
    let sql,params=[];
    if(op==='insert'){const keys=Object.keys(payload);params=keys.map(k=>payload[k]&&typeof payload[k]==='object'?JSON.stringify(payload[k]):payload[k]);sql=`insert into public.${ident(table)}(${keys.map(ident)}) values(${keys.map((_,i)=>'$'+(i+1))}) returning *`;}
    else{params=filters.map(([,v])=>v);sql=`select * from public.${ident(table)}`+(filters.length?' where '+filters.map(([k],i)=>`${ident(k)}=$${i+1}`).join(' and '):'')+(limit?' limit '+Number(limit):'');}
    const result=await db.query(sql,params);if(shape!=='many'&&result.rows.length>1)throw Error('FIXTURE_MULTIPLE_ROWS');return {data:shape==='many'?result.rows:result.rows[0]||null,error:null};
   }catch(error){return {data:null,error};}
  }
  return q;
 };
 return createCrmService({repository:createSupabaseCrmRepository({from},{commercialEmailTriageEnabled:false}),whatsappAtomicConversationEnabled:false});
}
