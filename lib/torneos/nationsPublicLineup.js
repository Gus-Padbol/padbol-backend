import {loadNationsMarkerMatchContext} from './nationsMarkerMatchContext.js';
const canon=v=>Array.isArray(v)?[...v].map(String).sort():v;
const same=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const key=p=>String(p?.user_id||p?.participante_id||p?.id||'').toLowerCase();
/** Only explicitly public scoreboard media in this project's bucket; never a profile avatar. */
export function trustedScoreboardPhoto(value,supabaseUrl){
 if(typeof value!=='string'||!supabaseUrl)return null;
 try{const u=new URL(value),base=new URL(supabaseUrl);if(u.protocol!=='https:'||u.origin!==base.origin||u.username||u.password||u.search||u.hash)return null;const path=decodeURIComponent(u.pathname);if(!path.startsWith('/storage/v1/object/public/scoreboard-fotos/')||path.split('/').some(x=>x==='..'||x==='.')||path.endsWith('/'))return null;return u.href;}catch{return null;}
}
function presentPlayer(p,active,raw,supabaseUrl){
 const matches=raw.filter(r=>key(r)===String(p.id).toLowerCase());const original=matches.length===1?matches[0]:null;
 const out={nombre:p.name,role:active.includes(p.id)?'on_court':'bench'};
 const dorsal=p.dorsal??original?.jersey??original?.numero;
 if((typeof dorsal==='string'||typeof dorsal==='number')&&String(dorsal).trim())out.jersey=String(dorsal).trim();
 const photo=trustedScoreboardPhoto(original?.foto_url,supabaseUrl);if(photo)out.foto_url=photo;
 return out;
}
/** Server-only repeatable snapshot; no writes, locks, audit actors or profile queries. */
export async function projectCurrentNationsLineup({pool,row,supabaseUrl,torneoId}){
 if(!pool?.connect)return null;
 let c;try{
  c=await pool.connect();
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const ctx=await loadNationsMarkerMatchContext(c,String(row.id));
  if(ctx.notNations||String(ctx.partidoTorneoId)!==String(row.partido_torneo_id)||row.torneo_id!=null&&String(ctx.torneoId)!==String(row.torneo_id)||torneoId!=null&&String(ctx.torneoId)!==String(torneoId))throw Error('PUBLIC_LINEUP_SCOPE');
  const a=(await c.query('SELECT revision,states,tracking_status FROM nations_marker_private.nations_marker_match WHERE match_id=$1',[String(row.id)])).rows[0];
  if(!a||a.tracking_status!=='active'||!Number.isSafeInteger(Number(a.revision))||Number(a.revision)<0||!object(a.states)||!same(Object.keys(a.states).sort(),Object.keys(ctx.teams).sort()))throw Error('PUBLIC_LINEUP_UNCONFIRMED');
  const out={nations_lineup_status:'current',nations_lineup_revision:Number(a.revision)};
  for(const side of ['A','B']){const team=ctx.teams[ctx.membership[side]],s=a.states[team.teamId],ids=team.players.map(p=>p.id);
   if(!object(s)||!['open','paused','closed','corrected'].includes(s.status)||!Array.isArray(s.active)||s.active.length!==2||new Set(s.active).size!==2||s.active.some(id=>!ids.includes(id))||!object(s.lineup)||!same(s.lineup.iniciales,team.lineup.iniciales)||!same(s.lineup.suplentes,team.lineup.suplentes)||!same(s.roster,ids))throw Error('PUBLIC_LINEUP_UNCONFIRMED');
   const field=side==='A'?'equipo_a_jugadores':'equipo_b_jugadores';const raw=Array.isArray(row[field])?row[field]:[];
   out[field]=team.players.map(p=>presentPlayer(p,s.active,raw,supabaseUrl));
  }
  await c.query('COMMIT');return out;
 }catch{try{await c?.query('ROLLBACK');}catch{}return null;}finally{c?.release();}
}
