import {createNationsMarkerDurableRouter} from './nationsMarkerDurableHttp.js';
import {hashControlToken,parseControlTokenParam,verifyControlToken} from '../src/scoreboard/scoreboardControlToken.js';
import {readNationsControlDelegation} from '../src/scoreboard/nationsControlDelegation.js';

const fail=(code,status)=>{throw Object.assign(new Error(code),{code,status});};
const PRIVATE_KEYS=new Set(['actor','actorId','actor_id','_meta','canon','delegation','issuerId','issuer_user_id','control_token_hash','tokenHash','token_hash']);
/** Capability holders see this match's sporting state, never audit principals or canonical request bodies. */
export function presentControlMarker(value){
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(presentControlMarker);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_KEYS.has(key)).map(([key,v])=>[key,presentControlMarker(v)]));
  return value;
}
async function tokenBoard(q,token,id=null){
  const result=await q.query(`SELECT s.id,s.sede_id,s.torneo_id,m.torneo_id AS linked_torneo_id,s.control_token_hash,s.control_token_created_at,s.control_token_revoked_at,t.modalidad_plantel,t.deporte
    FROM public.scoreboard_partidos s LEFT JOIN public.partidos m ON m.id=s.partido_torneo_id
    LEFT JOIN public.torneos t ON t.id=coalesce(m.torneo_id,s.torneo_id)
    WHERE ${id===null?'s.control_token_hash=$1':'s.id=$1'}`,[id===null?hashControlToken(token):id]);
  if(result.rows.length!==1||!verifyControlToken(token,result.rows[0].control_token_hash))fail('CONTROL_TOKEN_INVALID',401);
  const row=result.rows[0];
  if(row.control_token_revoked_at!=null)fail('CONTROL_TOKEN_REVOKED',401);
  if(row.torneo_id!=null&&row.linked_torneo_id!=null&&String(row.torneo_id)!==String(row.linked_torneo_id))fail('SCOREBOARD_TOURNAMENT_MISMATCH',409);
  if(row.modalidad_plantel!=='selecciones'||row.deporte!=='padbol')fail('NOT_NATIONS_TOURNAMENT',403);
  return row;
}
/** Same existing control capability; no user identity, role, client-supplied scoreboard or new token kind. */
export function createNationsMarkerControlTokenRouter({pool}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try{
      const url=new URL(req.url,'http://local');
      const route=url.pathname.match(/^\/api\/scoreboard\/control\/([^/]+)\/nations(?:\/(context|start|restart|team\/[^/]+\/commands|global\/commands))?$/);
      if(!route)return res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({code:'NOT_FOUND'}));
      let token;try{token=parseControlTokenParam(decodeURIComponent(route[1]));}catch{fail('CONTROL_TOKEN_INVALID',401);}
      if([...url.searchParams.keys()].some(key=>key!=='teamId')||url.searchParams.getAll('teamId').length>1)fail('BODY_AUTHORITY_FORBIDDEN',400);
      let body=req.body;
      if(req.method==='POST'&&body===undefined){
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)fail('BODY_INVALID',400);}
        try{body=JSON.parse(raw||'{}');}catch{fail('BODY_INVALID',400);}
      }
      if(req.method==='POST'&&(!body||typeof body!=='object'||Array.isArray(body)))fail('BODY_INVALID',400);
      if(body&&['scoreboardId','matchId','teamId','delegation','issuerId','issuer_user_id'].some(key=>Object.hasOwn(body,key)))fail('BODY_AUTHORITY_FORBIDDEN',400);
      const board=await tokenBoard(pool,token);
      const id=String(board.id);
      const authorize=async(_req,{matchId})=>{
        if(String(matchId)!==id)fail('CONTROL_TOKEN_SCOPE',403);
        const current=await tokenBoard(pool,token,id);
        await readNationsControlDelegation(pool,current);
        const actor={actorId:'control-token:'+hashControlToken(token),authorizeLocked:async(client,locked)=>{
          if(String(locked.id)!==id)fail('CONTROL_TOKEN_SCOPE',403);
          // The caller already holds this scoreboard FOR UPDATE through COMMIT.
          // Re-read after acquiring that lock: revocation/rotation which committed
          // while the request waited must deny writes, including receipt replays.
          const current=await tokenBoard(client,token,id);
          actor.delegation=await readNationsControlDelegation(client,current,{lock:true,actorId:actor.actorId});
        }};
        return actor;
      };
      const forwarded=Object.create(req);
      forwarded.body=body;
      forwarded.url=`/api/nations/marker/${encodeURIComponent(id)}${route[2]?'/'+route[2]:''}${url.search}`;
      return await createNationsMarkerDurableRouter({pool,authorize,present:presentControlMarker})(forwarded,res);
    }catch(e){return res.writeHead(e.status||503,{'content-type':'application/json'}).end(JSON.stringify({code:e.code||'CONTROL_UNAVAILABLE'}));}
  };
}
