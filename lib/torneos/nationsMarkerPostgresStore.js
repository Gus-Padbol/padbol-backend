/** Store Postgres durable para agregado Nations marker. CAS + auditoria atomica. */
import pg from 'pg';
const { Pool } = pg;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const stable=(v)=>Array.isArray(v)?v.map(stable):(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v);
const same = (a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NationsMarkerPostgresStore {
  constructor({ connectionString, pool } = {}) {
    this.pool = pool || new Pool({ connectionString, max: 5 });
  }
  validateMatch(matchId, next) {
    if (typeof matchId !== 'string' || !matchId.trim()) fail('MATCH_ID_REQUIRED');
    if (!next || !Number.isSafeInteger(next.revision) || next.revision < 0) fail('REVISION_INVALID');
    if (!isObject(next.states) || !isObject(next.receipts)) fail('AGGREGATE_INVALID');
    const teamKeys=Object.keys(next.states); if(teamKeys.length!==2||teamKeys.some(k=>!k)) fail('TEAMS_REQUIRED');
    for (const t of teamKeys) { const st=next.states[t]; if(!Number.isSafeInteger(st.revision)||!Array.isArray(st.events)||!Array.isArray(st.active)||st.active.length!==2||st.active.some(id=>!UUID.test(id))) fail('STATE_INVALID'); if(!st.lineup||!Array.isArray(st.lineup.iniciales)||st.lineup.iniciales.length!==2||!Array.isArray(st.lineup.suplentes)||st.lineup.suplentes.length>2) fail('LINEUP_INVALID');
      const lu=[...st.lineup.iniciales,...st.lineup.suplentes]; if(lu.length<2||lu.length>4||new Set(lu).size!==lu.length||lu.some(x=>!UUID.test(x))) fail('LINEUP_INVALID');
      if(st.active.some(x=>!lu.includes(x))) fail('ACTIVE_NOT_IN_LINEUP');
      if(st.events.length!==st.revision) fail('REVISION_EVENT_GAP');
      const ids=st.events.map(e=>e?.eventId); if(st.events.some(e=>!isObject(e)||typeof e.eventId!=='string'||!e.eventId||typeof e.type!=='string'||!e.type||!Number.isFinite(e.serverAt))||new Set(ids).size!==ids.length) fail('EVENT_INVALID'); }
    for (const [k,r] of Object.entries(next.receipts)) if(!isObject(r)||typeof k!=='string'||!k) fail('RECEIPTS_INVALID');
  }
  async getMatch(matchId) {
    const r = await this.pool.query('SELECT revision, states, receipts FROM nations_marker_private.nations_marker_match WHERE match_id=$1', [matchId]);
    if (!r.rows[0]) return null;
    const out={ revision: Number(r.rows[0].revision), states: r.rows[0].states, receipts: r.rows[0].receipts }; this.validateMatch(matchId,out); return out;
  }
  async createMatch(matchId, next) {
    this.validateMatch(matchId, next);
    const r = await this.pool.query(
      'INSERT INTO nations_marker_private.nations_marker_match (match_id, revision, states, receipts, updated_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,now()) ON CONFLICT (match_id) DO NOTHING RETURNING match_id',
      [matchId, next.revision, JSON.stringify(next.states), JSON.stringify(next.receipts)]
    );
    return r.rowCount === 1;
  }
  async saveMatch(matchId, next, { expectedRevision, audit } = {}) {
    this.validateMatch(matchId, next);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('EXPECTED_REVISION_INVALID');
    if (!audit || typeof audit.actor!=='string'||!audit.actor.trim()||audit.actor==='system'||typeof audit.kind!=='string'||!audit.kind.trim()||!isObject(audit.payload)||Object.keys(audit.payload).length===0||typeof audit.eventId!=='string'||!audit.eventId) fail('AUDIT_REQUIRED');
    if(!Object.values(next.states).flatMap(s=>s.events).some(e=>e.eventId===audit.eventId)) fail('AUDIT_EVENT_MISMATCH');
    if (next.revision !== expectedRevision + 1) fail('REVISION_STEP_INVALID');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT revision, states, receipts FROM nations_marker_private.nations_marker_match WHERE match_id=$1 FOR UPDATE', [matchId]);
      if (!cur.rows[0] || Number(cur.rows[0].revision) !== expectedRevision) { await client.query('ROLLBACK'); return false; }
      const prev={revision:expectedRevision,states:cur.rows[0].states,receipts:cur.rows[0].receipts}; this.validateMatch(matchId,prev);
      if(!same(Object.keys(prev.states).sort(),Object.keys(next.states).sort())) fail('TEAM_SCOPE_MUTATED');
      for(const t of Object.keys(prev.states)){const pe=prev.states[t].events, ne=next.states[t].events; if(ne.length<pe.length||!pe.every((e,i)=>same(e,ne[i]))) fail('EVENT_HISTORY_MUTATED');}
      for(const [k,v] of Object.entries(prev.receipts)) if(k!=='__clock' && !same(v,next.receipts[k])) fail('RECEIPTS_MUTATED');
      const upd = await client.query(
        'UPDATE nations_marker_private.nations_marker_match SET revision=$2, states=$3::jsonb, receipts=$4::jsonb, updated_at=now() WHERE match_id=$1 AND revision=$5',
        [matchId, next.revision, JSON.stringify(next.states), JSON.stringify(next.receipts), expectedRevision]
      );
      if (upd.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      await client.query(
        'INSERT INTO nations_marker_private.nations_marker_audit (match_id, revision, kind, actor, payload) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [matchId, next.revision, audit.kind, audit.actor, JSON.stringify({...audit.payload,eventId:audit.eventId})]
      );
      await client.query('COMMIT');
      return true;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
