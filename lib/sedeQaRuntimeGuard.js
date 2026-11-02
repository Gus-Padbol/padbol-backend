// QA-only admission: no credential values are returned or logged.
export const QA_PROJECT = 'vxikhdulhuvghfqeutnp';
export const QA_SERVICE = 'srv-dahbs0dbedkc73a0kf4g';
export const QA_URL = 'https://padbol-backend-qa.onrender.com';
const unavailable = () => Object.assign(new Error('QA_RUNTIME_UNAVAILABLE'), {status:503,code:'QA_RUNTIME_UNAVAILABLE'});
export const qaGuardRequired = (runtime, env) => runtime?.staging === true || env.RENDER_SERVICE_ID === QA_SERVICE;
export function assertQaRuntime(runtime, env) {
  if(runtime?.staging!==true || runtime.mode!=='staging' || runtime.outboundDeliveryEnabled!==false ||
    runtime.backgroundJobsEnabled!==false || runtime.pushSendEnabled!==false ||
    env.RENDER_SERVICE_ID!==QA_SERVICE || env.RENDER_EXTERNAL_URL!==QA_URL ||
    env.SUPABASE_URL!==`https://${QA_PROJECT}.supabase.co` ||
    env.STAGING_SUPABASE_PROJECT_REF!==QA_PROJECT || !/^[a-f0-9]{40}$/.test(env.RENDER_GIT_COMMIT||'')) throw unavailable();
}
export function assertQaClient(client) {
  const p=client?.connectionParameters;
  const direct=p?.host===`db.${QA_PROJECT}.supabase.co` && p.user==='postgres';
  const pooled=typeof p?.host==='string' && p.host.endsWith('.pooler.supabase.com') && p.user===`postgres.${QA_PROJECT}`;
  if(p?.database!=='postgres' || (!direct&&!pooled)) throw unavailable();
}
const query = `SELECT current_database() AS database_name, current_user AS sql_role,
 current_setting('transaction_isolation') AS isolation,
 current_setting('transaction_read_only') AS readonly,
 EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=$1::uuid AND role='super_admin') AS actor_authorized`;
// Used only with a leased client. The caller owns release; failed rollback destroys it.
async function inspect(client, actorId) {
  let began=false;
  try {
    assertQaClient(client);
    await client.query('BEGIN READ ONLY'); began=true;
    await client.query("SET LOCAL statement_timeout='3000ms'");
    const row=(await client.query(query,[actorId??null])).rows[0];
    if(row?.database_name!=='postgres'||row.sql_role!=='postgres'||row.isolation!=='read committed'||row.readonly!=='on') throw unavailable();
    if(actorId && row.actor_authorized!==true) throw Object.assign(new Error('SUPERADMIN_REQUIRED'),{status:403,code:'SUPERADMIN_REQUIRED'});
    return row;
  } finally {
    if(began) await client.query('ROLLBACK');
  }
}
async function acquire(pool,runtime,env,actorId) {
  assertQaRuntime(runtime,env);
  if(!pool?.connect) throw unavailable();
  const c=await pool.connect();
  try {await inspect(c,actorId);return c;}
  catch(error){c.release(true);throw error;}
}
export function createQaGuardedPool(pool,{runtime,env}) {
  if(!qaGuardRequired(runtime,env)) return pool;
  return {
    async connect(){return acquire(pool,runtime,env);},
    async query(...args){const c=await acquire(pool,runtime,env);try{return await c.query(...args);}finally{c.release();}},
  };
}
export function mountSedeQaDiagnostic(app,{pool,runtime,env=process.env,authUserFromBearer,assertSuperAdminReq}) {
  if(!qaGuardRequired(runtime,env)) return;
  app.get('/api/admin/sedes-pendientes/diagnostico-qa',async(req,res)=>{
    let c;
    try {
      const user=await authUserFromBearer(req);
      if(!user?.id)return res.status(401).json({code:'UNAUTHORIZED'});
      await assertSuperAdminReq(req);
      if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(user.id))return res.status(403).json({code:'SUPERADMIN_REQUIRED'});
      c=await acquire(pool,runtime,env,user.id);
      return res.json({ok:true,targetQA:true,actorAuthorized:true,readOnly:true,isolation:'read committed',release:env.RENDER_GIT_COMMIT});
    }catch(error){return res.status(error.status===401?401:error.status===403?403:503).json({code:error.status===403?'SUPERADMIN_REQUIRED':'QA_RUNTIME_UNAVAILABLE'});}
    finally{if(c)c.release();}
  });
}

export function mountQaLegacyAdmission(app,{runtime,env,pool,enabled}) {
  if(!qaGuardRequired(runtime,env))return;
  app.post('/api/admin/sedes-pendientes/:id/aprobar',(_req,res,next)=>{
    if(!enabled)return res.status(503).json({code:'QA_APPROVAL_CAPABILITY_OFF'});
    next();
  });
  app.post('/api/admin/sedes-pendientes/:id/rechazar',async(_req,res,next)=>{
    let c;try{c=await pool.connect();c.release();c=null;return next();}
    catch{return res.status(503).json({code:'QA_RUNTIME_UNAVAILABLE'});}
    finally{if(c)c.release();}
  });
}
