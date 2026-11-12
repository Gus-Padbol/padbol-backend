import {createHash} from 'node:crypto';
import {createRateLimiter,publicReadRateLimitIfMatch,publicReadRateLimit} from './rateLimit.js';
import {hashControlToken,parseControlTokenParam,verifyControlToken} from '../src/scoreboard/scoreboardControlToken.js';
const UUID='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const staffBoard=new RegExp(`^/api/scoreboard/partidos/(${UUID})$`),staffMarker=new RegExp(`^/api/nations/marker/(${UUID})(?:/context)?$`);
function candidate(req){if(req.method!=='GET')return null;const url=new URL(req.originalUrl||req.url,'http://local'),path=url.pathname;const token=path.match(/^\/api\/scoreboard\/control\/([^/]+)(?:\/nations(?:\/context)?)?$/);const staff=path.match(staffBoard)||path.match(staffMarker);if(!token&&!staff)return null;const target=token?{token:token[1]}:{board:staff[1],marker:path.startsWith('/api/nations/')};const teamAllowed=path.endsWith('/nations')||!!path.match(staffMarker)&&!path.endsWith('/context');if([...url.searchParams.keys()].some(k=>k!=='teamId'||!teamAllowed)||url.searchParams.getAll('teamId').length>1){target.invalidQuery=true;return target;}if(url.searchParams.has('teamId')){target.teamId=url.searchParams.get('teamId');if(!/^[1-9][0-9]*$/.test(target.teamId))target.invalidQuery=true;}return target;}
/** Fresh server-side authority only earns a per-board read budget; runtime auth is never skipped. */
export function createScoreboardVerifiedReadResolver({getPool,getAuthenticatedUser,fetchUserRoleRowForAuthUser}){
 return async(req,target)=>{const pool=getPool();if(!pool)return null;
  if(target.token){let token;try{token=parseControlTokenParam(decodeURIComponent(target.token));}catch{return null;}const hash=hashControlToken(token);const r=await pool.query('SELECT s.id,s.control_token_hash,s.control_token_revoked_at,m.equipo_a_id,m.equipo_b_id FROM public.scoreboard_partidos s LEFT JOIN public.partidos m ON m.id=s.partido_torneo_id WHERE s.control_token_hash=$1',[hash]);const b=r.rows[0];if(r.rows.length!==1||b.control_token_revoked_at!=null||!verifyControlToken(token,b.control_token_hash)||target.teamId&&![String(b.equipo_a_id),String(b.equipo_b_id)].includes(target.teamId))return null;return`board:${b.id}:cap:${hash}`;}
  const auth=await getAuthenticatedUser(req);if(!auth?.user?.id||auth.error||auth.status>=400)return null;const role=await fetchUserRoleRowForAuthUser(auth.user);if(!['super_admin','admin_club','admin_sede'].includes(role?.role))return null;const r=await pool.query('SELECT s.id,s.sede_id,m.equipo_a_id,m.equipo_b_id FROM public.scoreboard_partidos s LEFT JOIN public.partidos m ON m.id=s.partido_torneo_id WHERE s.id=$1',[target.board]);const b=r.rows[0];if(r.rows.length!==1||role.role!=='super_admin'&&(role.sede_id==null||Number(role.sede_id)!==Number(b.sede_id))||target.teamId&&![String(b.equipo_a_id),String(b.equipo_b_id)].includes(target.teamId))return null;return`board:${b.id}:user:${auth.user.id}`;
 };
}
/** 4 reads/5s = 720/15min; 1800 allows action readbacks while bounding each verified authority. */
export function createScoreboardReadRateLimit({resolve,verifiedLimit,publicLimit=publicReadRateLimitIfMatch,discoveryLimit=publicReadRateLimit}={}){
 const keys=new WeakMap(),known=new Map();const ttl=15*60*1000,maxEntries=10000;
 const dedicated=verifiedLimit||createRateLimiter({name:'scoreboard-verified-read',windowMs:ttl,max:1800,keyGenerator:req=>keys.get(req)});
 function budget(limiter,req,res){let pass=false;limiter(req,res,()=>{pass=true;});return pass;}
 return async(req,res,next)=>{const target=candidate(req);if(!target)return publicLimit(req,res,next);if(target.invalidQuery){if(budget(discoveryLimit,req,res))return next();return;}
  // This cache only recognizes a previously verified credential. NEVER authorizes a read:
  // every admitted request below rechecks current DB token revocation / persisted staff role.
  const credential=target.token?`cap:${target.token}`:`staff:${target.board}:${req.headers.authorization||''}`;
  const lookup=createHash('sha256').update(credential).digest('hex'),now=Date.now();let previous=known.get(lookup);
  if(previous&&previous.expires<=now){known.delete(lookup);previous=null;}
  if(previous){keys.set(req,previous.key);if(!budget(dedicated,req,res))return;}
  else if(!budget(discoveryLimit,req,res))return; // unknown/invalid lookup flood remains old150/IP, BEFORE DB/Auth
  let key;try{key=await resolve(req,target);}catch{key=null;}
  if(!key||previous&&previous.key!==key){known.delete(lookup);if(previous&&!budget(discoveryLimit,req,res))return;return next();}
  if(!previous){keys.set(req,key);if(!budget(dedicated,req,res))return;}
  if(known.size>=maxEntries&&!known.has(lookup)){for(const[k,v]of known)if(v.expires<=now)known.delete(k);if(known.size>=maxEntries)known.delete(known.keys().next().value);}
  known.set(lookup,{key,expires:now+ttl});return next();
 };
}
