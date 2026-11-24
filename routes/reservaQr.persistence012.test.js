import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountReservaQrRoutes } from './reservaQr.js';

/**
 * Focal HTTP contract for POST /api/reservas/:id/generar-qr.
 * Stateful Supabase-compatible adapter, actual route, synthetic owner/admin.
 * This is not PostgREST/JWT/PG/device proof.
 */
function fixture(initial = '') {
  const state = {
    row: { id: 1, user_id: 'u1', email: 'owner@example.test', sede: 'Sede QA', sede_id: 9, estado: 'confirmada', qr_token: initial },
    initialReads: 0, mutations: 0, writes: 0, failWrite: false, zeroCas: false,
    deleteAfterFirstRead: false, barrier: false, barrierReads: 0, mutationsAtRelease: null,
    gateRelease: null, gateReject: null, gateTimer: null, gate: null,
  };
  state.gate = new Promise((resolve, reject) => {
    state.gateRelease = resolve;
    state.gateReject = reject;
  });
  const db = {
    from(table) {
      if (table === 'sedes') {
        const q = { select(){return q;}, eq(){return q;}, maybeSingle: async()=>({data:{nombre:state.row?.sede ?? null},error:null}) };
        return q;
      }
      let action = 'read'; let filters = []; let payload = null;
      const q = {
        select(){ return q; },
        update(v){ if(table === 'reservas'){ action='update'; payload=v; } return q; },
        eq(k,v){ filters.push([k,v]); return q; },
        is(k,v){ filters.push([k,v]); return q; },
        maybeSingle(){
          if (action === 'update') {
            state.writes += 1;
            if (state.failWrite) return Promise.resolve({data:null,error:new Error('fixture write failure')});
            if (state.zeroCas || !state.row) return Promise.resolve({data:null,error:null});
            const matches = filters.every(([k,v]) => k === 'id' ? Number(state.row.id) === Number(v) : state.row[k] === v);
            if (!matches) return Promise.resolve({data:null,error:null});
            state.row.qr_token = payload.qr_token;
            state.mutations += 1;
            return Promise.resolve({data:{qr_token:state.row.qr_token},error:null});
          }
          state.initialReads += 1;
          if (state.barrier && state.initialReads <= 2) {
            const snapshot = state.row ? {...state.row} : null;
            state.barrierReads += 1;
            if (state.barrierReads === 1) {
              state.gateTimer = setTimeout(() => state.gateReject(new Error('second QR reader did not reach barrier')), 2000);
            } else {
              clearTimeout(state.gateTimer);
              state.mutationsAtRelease = state.mutations;
              state.gateRelease();
            }
            return state.gate.then(() => {
              if (state.deleteAfterFirstRead) state.row = null;
              return {data:snapshot,error:null};
            });
          }
          const snapshot = state.row ? {...state.row} : null;
          if (state.deleteAfterFirstRead) state.row = null;
          return Promise.resolve({data:snapshot,error:null});
        },
        then(resolve,reject){ return this.maybeSingle().then(resolve,reject); },
      };
      return q;
    },
  };
  return {state,db};
}
function appFor(f, role={role:'admin_club',sede_id:9}, user={id:'u1',email:'owner@example.test'}) {
  const app=express();
  mountReservaQrRoutes(app,{supabaseAdmin:f.db,getAuthenticatedUser:async(req)=>req.headers.authorization?{user}:{user:null},fetchUserRoleRowForAuthUser:async()=>role,legacySuperAdminEmails:[]});
  return app;
}
async function withServer(app, fn) {
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(r=>{ server.close(r); server.closeAllConnections?.(); }); }
}
const post=(base)=>fetch(`${base}/api/reservas/1/generar-qr`,{method:'POST',headers:{Authorization:'Bearer owner'},signal:AbortSignal.timeout(5000)}).then(async r=>({status:r.status,body:await r.json()}));
const qrTest = (name, fn) => test(name, {timeout:10000}, fn);

qrTest('sequential retry reuses one persisted token (historical control)', async()=>{
  const f=fixture(''); const app=appFor(f);
  const a=await withServer(app,post); const b=await withServer(app,post);
  assert.equal(a.status,200); assert.equal(b.status,200); assert.equal(a.body.qr_token,b.body.qr_token); assert.equal(f.state.mutations,1);
});
qrTest('true concurrent NULL initial: barrier forces two reads before CAS, one mutation', async()=>{
  const f=fixture(null); f.state.barrier=true; const app=appFor(f);
  const responses=await withServer(app,async(base)=>{
    const concurrent=await Promise.all([post(base),post(base)]);
    return [...concurrent,await post(base)];
  });
  assert.equal(f.state.barrierReads,2); assert.equal(f.state.mutationsAtRelease,0); assert.equal(f.state.mutations,1);
  assert.ok(f.state.row.qr_token);
  for (const response of responses) {
    assert.equal(response.status,200); assert.equal(response.body.qr_token,f.state.row.qr_token);
  }
});
qrTest('true concurrent empty-string initial: same persisted winner returned', async()=>{
  const f=fixture(''); f.state.barrier=true; const app=appFor(f);
  const responses=await withServer(app,async(base)=>{
    const concurrent=await Promise.all([post(base),post(base)]);
    return [...concurrent,await post(base)];
  });
  assert.equal(f.state.barrierReads,2); assert.equal(f.state.mutationsAtRelease,0); assert.equal(f.state.mutations,1);
  assert.ok(f.state.row.qr_token);
  for (const response of responses) {
    assert.equal(response.status,200); assert.equal(response.body.qr_token,f.state.row.qr_token);
  }
});
qrTest('existing nonempty token is reused without mutation', async()=>{
  const f=fixture('existing-token'); const r=await withServer(appFor(f),post);
  assert.equal(r.status,200); assert.equal(r.body.qr_token,'existing-token'); assert.equal(f.state.mutations,0);
});
qrTest('row disappears after initial authorization before CAS: no 2xx/token', async()=>{
  const f=fixture(null); f.state.deleteAfterFirstRead=true; const r=await withServer(appFor(f),post);
  assert.ok(r.status>=300); assert.equal(r.body.qr_token,undefined); assert.equal(f.state.row,null);
});
qrTest('zero CAS/empty token cannot become false success', async()=>{
  const f=fixture(''); f.state.zeroCas=true; const r=await withServer(appFor(f),post);
  assert.ok(r.status>=300); assert.equal(r.body.qr_token,undefined); assert.equal(f.state.row.qr_token,'');
});
qrTest('write failure leaves state unchanged and is non-2xx', async()=>{
  const f=fixture(null); f.state.failWrite=true; const r=await withServer(appFor(f),post);
  assert.ok(r.status>=300); assert.equal(r.body.qr_token,undefined); assert.equal(f.state.row.qr_token,null); assert.equal(f.state.mutations,0);
});
qrTest('cancelled booking is denied before any QR write', async()=>{
  const f=fixture(null); f.state.row.estado='cancelada'; const r=await withServer(appFor(f),post);
  assert.equal(r.status,400); assert.equal(f.state.writes,0); assert.equal(f.state.row.qr_token,null);
});
qrTest('unrelated actor is denied without write', async()=>{
  const f=fixture(null); const r=await withServer(appFor(f,{role:'jugador',sede_id:null},{id:'u2',email:'other@example.test'}),post);
  assert.equal(r.status,403); assert.equal(f.state.writes,0);
});
qrTest('explicit foreign sede ID is denied despite the same legacy display name', async()=>{
  const f=fixture(null);
  const r=await withServer(appFor(f,{role:'admin_club',sede_id:8},{id:'admin8',email:'admin8@example.test'}),post);
  assert.equal(r.status,403); assert.equal(f.state.writes,0); assert.equal(f.state.row.qr_token,null);
});
qrTest('matching-ID admin who is not owner may generate the persisted QR', async()=>{
  const f=fixture(null);
  const r=await withServer(appFor(f,{role:'admin_club',sede_id:9},{id:'admin9',email:'admin9@example.test'}),post);
  assert.equal(r.status,200); assert.ok(r.body.qr_token); assert.equal(r.body.qr_token,f.state.row.qr_token);
});
qrTest('owner user ID permission remains valid without an admin role or matching email', async()=>{
  const f=fixture(null);
  const r=await withServer(appFor(f,{role:'jugador'},{id:'u1',email:'different@example.test'}),post);
  assert.equal(r.status,200); assert.ok(r.body.qr_token); assert.equal(r.body.qr_token,f.state.row.qr_token);
});
qrTest('owner email permission remains valid without an admin role or matching user ID', async()=>{
  const f=fixture(null);
  const r=await withServer(appFor(f,{role:'jugador'},{id:'email-owner',email:' OWNER@EXAMPLE.TEST '}),post);
  assert.equal(r.status,200); assert.ok(r.body.qr_token); assert.equal(r.body.qr_token,f.state.row.qr_token);
});
qrTest('truly ID-less legacy booking preserves its existing name fallback', async()=>{
  const f=fixture(null); f.state.row.sede_id=null;
  const r=await withServer(appFor(f,{role:'admin_club',sede_id:9},{id:'admin9',email:'admin9@example.test'}),post);
  assert.equal(r.status,200); assert.ok(r.body.qr_token); assert.equal(r.body.qr_token,f.state.row.qr_token);
});
