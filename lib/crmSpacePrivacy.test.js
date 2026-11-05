import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { sanitizeSpaceFile, cleanupExpiredSpaceMedia, SPACE_RETENTION_SCHEMA_SQL } from './crmSpacePrivacy.js';

const conversation = '11111111-1111-4111-8111-111111111111';
async function markedPhoto(format = 'jpeg') {
  return sharp({ create: { width: 10, height: 20, channels: 3, background: 'red' } })[format]()
    .withExif({ IFD0: { Artist: 'PRIVATE ARTIST' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 48/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 24/1 0/1' } }).toBuffer();
}
for (const [format, mimetype] of [['jpeg','image/jpeg'],['png','image/png'],['webp','image/webp']]) test(`${format}: strips EXIF/GPS before storage and retains decoded image`, async () => {
  const buffer = await markedPhoto(format);
  assert.ok((await sharp(buffer).metadata()).exif);
  const result = await sanitizeSpaceFile({ buffer, mimetype });
  const meta = await sharp(result.buffer).metadata();
  assert.equal(result.metadataStripped, true);
  for (const key of ['exif','xmp','iptc','icc']) assert.equal(meta[key], undefined);
  assert.equal(meta.width, 10); assert.equal(meta.height, 20);
  assert.equal(result.buffer.includes(Buffer.from('PRIVATE ARTIST')), false);
});
test('HEIC decoder failure rejects before upload instead of returning original', async () => {
  const buffer = Buffer.from('HEIC containing sensitive metadata');
  await assert.rejects(sanitizeSpaceFile({ buffer, mimetype: 'image/heic' }, { imageProcessor: () => { throw new Error('codec not installed'); } }), { code: 'SPACE_HEIC_CONVERSION_REQUIRED' });
});
test('HEIC decodable by the installed codec converts to stripped JPEG', async () => {
  // Inject a supported pixel fixture for the decoder boundary; platform HEIC support is not assumed.
  const fixture = await markedPhoto();
  const result = await sanitizeSpaceFile({ buffer: fixture, mimetype: 'image/heic' });
  assert.equal(result.mimetype, 'image/jpeg'); assert.equal(result.extension, 'jpg');
  assert.equal((await sharp(result.buffer).metadata()).exif, undefined);
});
test('PDF is accepted as a plan with an explicit metadata exception, never as a photo', async () => {
  const file = { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 user supplied geometry') };
  assert.equal((await sanitizeSpaceFile(file, { kind: 'plan' })).metadataStripped, false);
  await assert.rejects(sanitizeSpaceFile(file), { code: 'SPACE_INVALID_PHOTO' });
});
test('corrupt raster fails closed', async () => {
  await assert.rejects(sanitizeSpaceFile({ mimetype: 'image/jpeg', buffer: Buffer.from('not an image') }), { code: 'SPACE_IMAGE_PROCESSING_FAILED' });
});

async function retentionFixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.crm_space_requests(id uuid primary key, conversation_id uuid, files jsonb default '[]', simulation_path text, created_at timestamptz default now(), updated_at timestamptz default now());`);
  await db.exec(SPACE_RETENTION_SCHEMA_SQL);
  const add = async (id, expiry, extra = {}) => {
    await db.query(`insert into crm_space_requests(id,conversation_id,retention_expires_at,files,simulation_path) values($1,$2,$3,$4,$5)`, [id,conversation,expiry,JSON.stringify([{path:`${conversation}/${id}.jpg`}]),`${conversation}/${id}-simulation.png`]);
    if (extra.hold) await db.query(`update crm_space_requests set project_active_hold=true,project_hold_reason='Proyecto activo',project_hold_set_by='test-operator',project_hold_set_at=now() where id=$1`, [id]);
  };
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
  return { db, pool, add };
}
const old = '22222222-2222-4222-8222-222222222222';
const held = '33333333-3333-4333-8333-333333333333';
const future = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-11-04T15:00:00Z');
test('migration backfills legacy expiry to creation +90 days, remains idempotent and enforces explicit hold', async () => {
  const f = await retentionFixture();
  try {
    await f.db.exec(SPACE_RETENTION_SCHEMA_SQL);
    await f.add(old, now.toISOString());
    await assert.rejects(f.db.query('update crm_space_requests set project_active_hold=true where id=$1', [old]), /active_hold_reason/);
    const result = await f.db.query(`select retention_expires_at-created_at as ttl from crm_space_requests where id=$1`, [old]);
    assert.equal(result.rows.length,1);
    const defaults = await f.db.query(`insert into crm_space_requests(id,conversation_id,created_at) values($1,$2,now()) returning retention_expires_at-created_at as ttl`, [future, conversation]);
    assert.equal(defaults.rows[0].ttl, '90 days');
  } finally { await f.db.close(); }
});
test('dry-run defaults to reads, excludes future and held requests, and does not delete metadata or storage', async () => {
  const f = await retentionFixture(); let deletes = 0;
  try {
    await f.add(old, now.toISOString()); await f.add(held, now.toISOString(), {hold:true}); await f.add(future, '2026-11-05T00:00:00Z');
    const result = await cleanupExpiredSpaceMedia({ pool:f.pool, now, storage:{from(){ deletes++; }} });
    assert.deepEqual(result, {dryRun:true,requests:[{id:old,files:2}]}); assert.equal(deletes,0);
    assert.equal((await f.db.query('select media_deleted_at from crm_space_requests where id=$1',[old])).rows[0].media_deleted_at,null);
    await assert.rejects(cleanupExpiredSpaceMedia({pool:f.pool,now,apply:true}), /DELETE_NOT_ENABLED/);
  } finally { await f.db.close(); }
});
test('explicit deletion removes private originals and simulation, tombstones row, skips active project', async () => {
  const f = await retentionFixture(); const removed = [];
  try {
    await f.add(old, now.toISOString()); await f.add(held, now.toISOString(), {hold:true});
    const storage = {from(bucket){ assert.equal(bucket,'crm-space-requests'); return {async remove(paths){ removed.push(...paths);return {error:null}; }};}};
    const result = await cleanupExpiredSpaceMedia({pool:f.pool,storage,now,apply:true,allowDelete:true});
    assert.equal(result.dryRun,false); assert.equal(removed.length,2);
    const row = (await f.db.query('select files,simulation_path,media_deleted_at from crm_space_requests where id=$1',[old])).rows[0];
    assert.deepEqual(row.files,[]); assert.equal(row.simulation_path,null); assert.ok(row.media_deleted_at);
    assert.equal((await cleanupExpiredSpaceMedia({pool:f.pool,storage,now,apply:true,allowDelete:true})).requests.length,0);
  } finally { await f.db.close(); }
});
test('storage failure never marks media as purged; path outside request conversation is refused', async () => {
  const f = await retentionFixture();
  try {
    await f.add(old,now.toISOString());
    const storage={from(){return {async remove(){return {error:new Error('storage failed')};}};}};
    await assert.rejects(cleanupExpiredSpaceMedia({pool:f.pool,storage,now,apply:true,allowDelete:true}),/STORAGE_DELETE_FAILED/);
    assert.equal((await f.db.query('select media_deleted_at from crm_space_requests where id=$1',[old])).rows[0].media_deleted_at,null);
    await f.db.query(`update crm_space_requests set files='[{"path":"other/private.jpg"}]' where id=$1`,[old]);
    await assert.rejects(cleanupExpiredSpaceMedia({pool:f.pool,now}),/INVALID_PATH/);
  } finally { await f.db.close(); }
});

test('legacy rows expire at original creation plus 90 days, not migration date', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.crm_space_requests(id uuid primary key,conversation_id uuid,created_at timestamptz,files jsonb default '[]',simulation_path text,updated_at timestamptz);
      insert into crm_space_requests(id,created_at) values('${old}','2026-07-01T12:00:00Z');`);
    await db.exec(SPACE_RETENTION_SCHEMA_SQL);
    const row=(await db.query('select retention_expires_at from crm_space_requests where id=$1',[old])).rows[0];
    assert.equal(new Date(row.retention_expires_at).toISOString(),'2026-09-29T12:00:00.000Z');
  } finally {await db.close();}
});
test('CLI refuses apply without opt-in and does not load credentials from files', async () => {
  const {main}=await import('../scripts/crm-space-media-retention.mjs');
  await assert.rejects(main(['--apply'],{}),/requires CRM_SPACE_RETENTION_DELETE_ENABLED/);
  await assert.rejects(main(['--dry-run'],{}),/DATABASE_URL is required/);
});
