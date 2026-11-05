import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { registerCrmInboundRoutes } from './crmInboundRoutes.js';

const conversationId='11111111-1111-4111-8111-111111111111';
function fixture({eligibility='allowed'}={}) {
  let handler; const uploads=[]; const inserts=[];let buckets=0;
  const app={post(path,...handlers){if(path==='/api/inbound/crm/space-request') handler=handlers.at(-1);}};
  const db={storage:{async createBucket(){buckets++;return {error:null};},from(){return {async upload(path,buffer,options){uploads.push({path,buffer,options});return {error:null};}};}}};
  const pool={async query(sql,values){if(sql.startsWith('select c.id')){assert.match(sql,/c.test_hidden_at is null/);assert.match(sql,/c.email_return_linked_to is null/);assert.match(sql,/crm_commercial_form_is_allowed\(c.id\)/);assert.match(sql,/coalesce\(f.progress_state,c.estado\)<>'cerrado'/);return {rows:eligibility==='allowed'?[{id:conversationId,contact_id:'contact-id',estado:'nuevo'}]:[]};}if(sql.startsWith('insert into')){inserts.push(values);return {rows:[{id:'request-id',status:'recibida'}]};}return {rows:[]};}};
  const experienceRepository={async createActivity(){return {id:'activity-id'};},async markHandoff(){}};
  registerCrmInboundRoutes(app,{crmService:{},experienceRepository,db,pool,logger:{warn(){}}});
  const req={body:{conversationId,consent:'true',lengthM:'10',widthM:'10',covered:'false',spaceShape:'rectangular',desiredCourts:'1'},files:{photos:[]}};
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
  return {req,res,uploads,inserts,get buckets(){return buckets;},run:()=>handler(req,res)};
}
test('intake uploads only sanitized photo pixels and avoids retaining original filename',async()=>{
  const f=fixture();Object.assign(f.req.body,{covered:'true',heightM:'5.5'});const buffer=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).jpeg().withExif({IFD0:{Artist:'SECRET ARTIST'}}).toBuffer();
  f.req.files.photos=[{buffer,size:buffer.length,mimetype:'image/jpeg',originalname:'home-address-private.jpg'}];
  await f.run(); assert.equal(f.res.statusCode,201);assert.equal(f.uploads.length,1);
  assert.equal((await sharp(f.uploads[0].buffer).metadata()).exif,undefined);
  const stored=JSON.parse(f.inserts[0][7]);assert.equal(stored[0].name,'foto-1.jpg');assert.equal(stored[0].metadataStripped,true);
  assert.equal(JSON.stringify(stored).includes('home-address'),false);
});
test('all files are sanitized before first upload, so a later corrupt image stores nothing',async()=>{
  const f=fixture();const buffer=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).jpeg().toBuffer();
  f.req.files.photos=[{buffer,size:buffer.length,mimetype:'image/jpeg',originalname:'ok.jpg'},{buffer:Buffer.from([255,216,0,0]),size:4,mimetype:'image/jpeg',originalname:'corrupt.jpg'}];
  await f.run();assert.equal(f.res.statusCode,400);assert.equal(f.res.body.code,'SPACE_IMAGE_PROCESSING_FAILED');assert.equal(f.uploads.length,0);assert.equal(f.buckets,0);assert.equal(f.inserts.length,0);
});

test('hidden, linked, closed and out-of-scope enquiries cannot store uploaded material',async()=>{
 for(const eligibility of ['hidden','linked','closed','non-commercial']){const f=fixture({eligibility});await f.run();assert.equal(f.res.statusCode,404);assert.equal(f.res.body.code,'SPACE_NOT_FOUND');assert.equal(f.uploads.length,0);assert.equal(f.buckets,0);assert.equal(f.inserts.length,0);}
});
test('height below 5.5 m is rejected before storage',async()=>{const f=fixture();Object.assign(f.req.body,{covered:'true',heightM:'5.49'});await f.run();assert.equal(f.res.statusCode,400);assert.equal(f.res.body.code,'SPACE_INVALID_HEIGHT');assert.equal(f.uploads.length,0);});
test('requested courts cannot exceed the indicative regular layout',async()=>{const f=fixture();f.req.body.desiredCourts='8';await f.run();assert.equal(f.res.statusCode,400);assert.equal(f.res.body.code,'SPACE_COURT_COUNT_EXCEEDS_REGULAR_LAYOUT');assert.equal(f.uploads.length,0);});
test('L-shaped spaces require a sketch before any storage',async()=>{const f=fixture();f.req.body.spaceShape='l-shaped';await f.run();assert.equal(f.res.statusCode,400);assert.equal(f.res.body.code,'SPACE_PLAN_REQUIRED');assert.equal(f.uploads.length,0);});
