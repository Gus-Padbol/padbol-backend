import express from 'express';
import {requireAuthenticatedUser} from '../lib/authAccess.js';
import {isScoreboardReadId} from '../lib/scoreboardReadId.js';

// Private, ephemeral adaptation of tools/padbol-live-pilot at ea2126d6.
// No score writes, persistent stream registry, public capability or media storage.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSIONS=8,FRAME_BYTES=300000,SIGNAL_BYTES=16384,QUEUE_SIZE=32;
const LEASE_MS=12000,IDLE_MS=60000,SIGNAL_MS=120000;
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
export function createScoreboardLiveRouter(deps){
 const router=express.Router({mergeParams:true}),sessions=new Map();
 const clock=deps.now||Date.now;let uploads=0;
 const enabled=()=>deps.enabled===true || (deps.enabled===undefined&&process.env.PADBOL_LIVE_PRIVATE_ENABLED==='true');
 function cleanup(){const now=clock();for(const [id,s] of sessions)if(now-s.at>IDLE_MS)sessions.delete(id);}
 async function authority(req,res){
  // Auth/JWT verification can involve I/O; finish it before acquiring DB locks.
  const user=await requireAuthenticatedUser(req,res,deps.getAuthenticatedUser);if(!user)return null;
  if(!deps.pgPool?.connect)throw fail(503,'LIVE_AUTH_UNAVAILABLE');
  const client=await deps.pgPool.connect();
  try{
   await client.query('BEGIN');
   await client.query("SET LOCAL statement_timeout='3000ms'; SET LOCAL lock_timeout='2000ms'");
   // Same lock order on every call. No email fallback or new role semantics.
   const roles=await client.query('SELECT role,sede_id FROM public.user_roles WHERE user_id=$1::uuid ORDER BY id FOR SHARE',[user.id]);
   if(roles.rows.length!==1||!['super_admin','admin_club'].includes(roles.rows[0].role))throw fail(403,'LIVE_FORBIDDEN');
   const result=await client.query('SELECT id,sede_id FROM public.scoreboard_partidos WHERE id=$1::uuid FOR SHARE',[req.params.id]);
   const board=result.rows[0],role=roles.rows[0];if(!board)throw fail(404,'LIVE_MATCH_NOT_FOUND');
   if(role.role!=='super_admin'&&Number(role.sede_id)!==Number(board.sede_id))throw fail(403,'LIVE_FORBIDDEN');
   const snapshot={actor:user.id,board:String(board.id),sede:Number(board.sede_id)};
   // Authorization linearizes at this commit. A later revocation is not retroactive.
   await client.query('COMMIT');return snapshot;
  }catch(error){try{await client.query('ROLLBACK');}catch{}if(error.status)throw error;throw fail(503,'LIVE_AUTH_UNAVAILABLE');}
  finally{client.release();}
 }
 function input(req){
  const role=req.query.role,client=req.get('X-Live-Client'),generation=Number(req.get('X-Live-Generation'));
  if(!['camera','screen'].includes(role)||!UUID.test(client||'')||!Number.isSafeInteger(generation)||generation<1)throw fail(400,'LIVE_INVALID_CONTEXT');
  return {role,client,generation};
 }
 function owned(s,t,actor){const o=s.owners[t.role];return o&&o.actor===actor&&o.client===t.client&&o.generation===t.generation&&clock()-o.at<LEASE_MS;}
 function guard(s,t,a,stop){
  if(sessions.get(a.board)!==s||s.sede!==a.sede||!owned(s,t,a.actor))throw fail(409,'LIVE_RUN_STALE');
  if(!Number.isSafeInteger(stop)||stop!==s.stopVersion)throw fail(409,'LIVE_STOP_STALE');
 }
 async function recheck(req,res,a,s,t,stop){const next=await authority(req,res);if(!next)return false;if(next.actor!==a.actor||next.board!==a.board||next.sede!==a.sede)throw fail(403,'LIVE_FORBIDDEN');guard(s,t,next,stop);return true;}
 const context=(a,t)=>({scoreboardId:a.board,role:t.role,clientId:t.client,generation:t.generation});
 const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');try{
  if(!enabled())throw fail(503,'LIVE_DISABLED');if(!isScoreboardReadId(req.params.id))throw fail(400,'LIVE_INVALID_MATCH');cleanup();
  const a=await authority(req,res);if(!a)return;const t=input(req);
  const json=res.json.bind(res);res.json=body=>json({...body,context:context(a,t)});
  res.set('X-Live-Board',a.board);res.set('X-Live-Role',t.role);res.set('X-Live-Client',t.client);res.set('X-Live-Generation',String(t.generation));
  await fn(req,res,a,t);
 }catch(e){if(!res.headersSent)res.status(e.status||503).json({error:e.code||'LIVE_UNAVAILABLE',code:e.code||'LIVE_UNAVAILABLE'});}};
 router.post('/start',route(async(req,res,a,t)=>{
  let s=sessions.get(a.board);if(!s){if(sessions.size>=MAX_SESSIONS)throw fail(503,'LIVE_CAPACITY');s={sede:a.sede,at:clock(),owners:{},queues:{camera:[],screen:[]},frame:null,frameAt:0,stopVersion:0,next:0};sessions.set(a.board,s);}
  if(s.sede!==a.sede){sessions.delete(a.board);throw fail(409,'LIVE_CONTEXT_CHANGED');}
  const old=s.owners[t.role];if(old&&clock()-old.at<LEASE_MS&&(old.actor!==a.actor||old.client!==t.client))throw fail(409,'LIVE_ROLE_BUSY');
  if(old&&old.actor===a.actor&&old.client===t.client&&t.generation<=old.generation)throw fail(409,'LIVE_RUN_STALE');
  s.owners[t.role]={actor:a.actor,client:t.client,generation:t.generation,at:clock()};s.at=clock();
  // A replaced camera may not leave its last image/signalling as a new run's AV.
  if(t.role==='camera'){s.frame=null;s.frameAt=0;s.upload=null;}s.queues={camera:[],screen:[]};
  res.json({scoreboardId:a.board,generation:t.generation,stopVersion:s.stopVersion,peerOnline:peerOnline(s,t.role)});
 }));
 function peerOnline(s,role){const p=s.owners[role==='camera'?'screen':'camera'];return !!p&&clock()-p.at<LEASE_MS;}
 function session(req,a,t){const s=sessions.get(a.board),stop=Number(req.get('X-Live-Stop-Version'));if(!s)throw fail(409,'LIVE_RUN_STALE');guard(s,t,a,stop);return {s,stop};}
 router.get('/frame',route(async(req,res,a,t)=>{if(t.role!=='screen')throw fail(403,'LIVE_ROLE_FORBIDDEN');const {s,stop}=session(req,a,t);if(!await recheck(req,res,a,s,t,stop))return;s.at=clock();s.owners[t.role].at=clock();if(!s.frame||!peerOnline(s,'screen')||clock()-s.frameAt>6000)return res.status(204).end();res.set('Content-Type','image/jpeg');res.set('X-Frame-At',String(s.frameAt));res.send(s.frame);}));
 router.post('/frame',route(async(req,res,a,t)=>{
  if(t.role!=='camera')throw fail(403,'LIVE_ROLE_FORBIDDEN');if(!req.is('image/jpeg'))throw fail(415,'LIVE_JPEG_REQUIRED');const {s,stop}=session(req,a,t);
  if(s.upload||uploads>=8)throw fail(409,'LIVE_FRAME_BUSY');const upload={};s.upload=upload;uploads++;
  try{
  const parts=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>FRAME_BYTES)throw fail(413,'LIVE_FRAME_TOO_LARGE');parts.push(chunk);}
  const frame=Buffer.concat(parts);if(frame.length<4||frame[0]!==255||frame[1]!==216||frame.at(-2)!==255||frame.at(-1)!==217)throw fail(400,'LIVE_JPEG_INVALID');
  if(!await recheck(req,res,a,s,t,stop))return;s.frame=frame;s.frameAt=clock();s.at=clock();s.owners[t.role].at=clock();res.json({ok:true});
  }finally{uploads--;if(s.upload===upload)s.upload=null;}
 }));
 router.get('/poll',route(async(req,res,a,t)=>{
  const {s,stop}=session(req,a,t),after=Number(req.query.after||0);if(!Number.isSafeInteger(after)||after<0)throw fail(400,'LIVE_INVALID_CURSOR');
  if(!await recheck(req,res,a,s,t,stop))return;s.queues[t.role]=s.queues[t.role].filter(x=>clock()-x.at<SIGNAL_MS && x.to.actor===a.actor && x.to.client===t.client && x.to.generation===t.generation && owned(s,x.from,x.from.actor));s.at=clock();s.owners[t.role].at=clock();res.json({messages:s.queues[t.role].filter(x=>x.id>after).map(x=>({...x.payload,id:x.id,at:x.at,stopVersion:x.stopVersion})),peerOnline:peerOnline(s,t.role),stopVersion:s.stopVersion});
 }));
 router.post('/signal',route(async(req,res,a,t)=>{
  const {s,stop}=session(req,a,t),body=req.body;
  if(!body||!['offer','answer','ice','ready','stop'].includes(body.type)||Object.keys(body).some(k=>!['type','sdp','candidate','negotiation','readyId'].includes(k))||Buffer.byteLength(JSON.stringify(body))>SIGNAL_BYTES)throw fail(400,'LIVE_SIGNAL_INVALID');
  if(['negotiation','readyId'].some(k=>body[k]!=null&&(typeof body[k]!=='string'||body[k].length>160))||body.sdp!=null&&(typeof body.sdp!=='string'||Buffer.byteLength(body.sdp)>12000)||body.candidate!=null&&(typeof body.candidate!=='object'||Array.isArray(body.candidate)))throw fail(400,'LIVE_SIGNAL_INVALID');
  if(!await recheck(req,res,a,s,t,stop))return;const target=t.role==='camera'?'screen':'camera',to=s.owners[target];if(to&&peerOnline(s,t.role))s.queues[target].push({payload:structuredClone(body),from:{...t,actor:a.actor},to:{...to},id:++s.next,at:clock(),stopVersion:s.stopVersion});s.queues[target]=s.queues[target].filter(x=>clock()-x.at<SIGNAL_MS).slice(-QUEUE_SIZE);s.at=clock();s.owners[t.role].at=clock();res.json({ok:true});
 }));
 router.post('/stop',route(async(req,res,a,t)=>{
  const {s,stop}=session(req,a,t);if(!await recheck(req,res,a,s,t,stop))return;s.frame=null;s.frameAt=0;s.queues={camera:[],screen:[]};s.stopVersion++;s.at=clock();res.json({ok:true,stopVersion:s.stopVersion});
 }));
 return router;
}
