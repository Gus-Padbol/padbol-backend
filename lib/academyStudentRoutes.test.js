import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerAcademyStudentRoutes} from './academyStudentRoutes.js';
import {loadAcademyCatalog,validateAcademyCatalog} from './academyCatalog.js';
const academyCourses=[
 {id:94436,title:'Synthetic referee course',lang:'es',slug:'fixture-referee',quizRef:94480,materialRefs:[94488],lessons:[{id:93526,title:'Fixture one',status:'publish',materialRefs:[]},{id:93528,title:'Fixture two',status:'publish',materialRefs:[]}]},
 {id:94439,title:'Synthetic coach course',lang:'es',slug:'fixture-coach',quizRef:94505,materialRefs:[94508],lessons:[{id:94502,title:'MATERIAL',status:'draft',materialRefs:[94508]}]},
 {id:95062,title:'Synthetic video course',lang:'en',slug:'fixture-video',quizRef:null,materialRefs:[],lessons:[{id:95078,title:'Fixture video',status:'publish',materialRefs:[],videoRef:'fixture'}]},
];
const quizForCourse=id=>syntheticCatalog.quizzesByCourse[id];
const syntheticCatalog={courses:academyCourses,quizzesByCourse:Object.fromEntries(academyCourses.filter(c=>c.quizRef).map(c=>[c.id,{id:c.quizRef,course:c.id,title:'Fixture exam',passThresholdPct:80,questions:[{text:'Synthetic question A',options:['Fixture A','Fixture B'],correctIndex:0},{text:'Synthetic question B',options:['Fixture C','Fixture D'],correctIndex:1}]}])),videos:{fixture:{youtubeId:'TEST_ONLY_ID',title:'Fixture video'}},materials:{'reglamento-arbitros-es':{title:'Fixture referee manual',file:'/academy/materials/reglamento-arbitros-es.pdf'},'manual-entrenadores-es':{title:'Fixture coach manual',file:'/academy/materials/manual-entrenadores-es.pdf'}},materialAliases:{94488:'reglamento-arbitros-es',94508:'manual-entrenadores-es'}};
const user={id:'11111111-1111-4111-8111-111111111111',email_confirmed_at:'2026-01-01'};
const requestId='22222222-2222-4222-8222-222222222222';
function fixture({auth=user,enrolled=true,courseId=94436,complete=true}={}) {
 const course=academyCourses.find(c=>c.id===courseId);
 const tables={academy_enrollments:enrolled?[{user_id:user.id,course_id:courseId}]:[],academy_progress:complete?course.lessons.filter(l=>l.status==='publish').map(l=>({user_id:user.id,course_id:courseId,lesson_id:l.id,completed_at:'2026-01-01'})):[],academy_certificates:[],academy_quiz_attempts:[],academy_profiles:[{id:user.id,full_name:'Alumno Real'}]};
 const calls=[],signings=[]; let unavailable=false,storageError=false;
 const db={from(table){calls.push(table); let predicates=[],payload,operation='read',options={},single=false;
 const q={select(){return q;},eq(k,v){predicates.push(r=>r[k]===v);return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},insert(v){operation='insert';payload=v;return q;},upsert(v,o){operation='upsert';payload=v;options=o;return q;},then(resolve){if(unavailable)return Promise.resolve({error:{code:'offline'}}).then(resolve); let rows=tables[table]; if(operation!=='read'){const keys=options.onConflict?.split(',')||['id'];const existing=rows.find(r=>keys.every(k=>r[k]===payload[k]));if(existing&&operation==='insert')return Promise.resolve({error:{code:'23505'}}).then(resolve);if(!existing){rows.push({...payload});}else if(operation==='upsert'&&!options.ignoreDuplicates){Object.assign(existing,payload);} }const found=rows.filter(r=>predicates.every(p=>p(r)) && (operation==='read'||r===rows.find(row=>Object.keys(payload).every(k=>row[k]===payload[k]))));return Promise.resolve({data:single?found[0]||null:found,error:null}).then(resolve);}};return q;}};
 db.storage={from(bucket){return {async createSignedUrl(path,ttl){signings.push({bucket,path,ttl});return storageError?{error:{code:'offline'}}:{data:{signedUrl:'https://private.test/signed/example?token=fixture'}};}};}};
 const handlers={}; registerAcademyStudentRoutes({get(_p,h){handlers.GET=h;},post(_p,h){handlers.POST=h;}},{db,catalog:syntheticCatalog,authUserFromBearer:async()=>auth,logger:{error(){}}});
 async function run(method,input){const res={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await handlers[method]({query:input,body:input},res);return res;}
 return {run,tables,calls,signings,storageOffline(){storageError=true;},offline(){unavailable=true;}};
}
test('anonymous, ungranted and unknown courses cannot access privileged student data',async()=>{
 const anon=fixture({auth:null});assert.equal((await anon.run('GET',{resource:'enrollments'})).statusCode,401);assert.equal(anon.calls.length,0);
 for(const resource of ['lesson','progress','quiz']){const f=fixture({enrolled:false});assert.equal((await f.run('GET',{resource,courseId:94436,lessonId:93526})).statusCode,403);assert.deepEqual(f.calls,['academy_enrollments']);}
 const f=fixture();assert.equal((await f.run('POST',{resource:'progress',courseId:1,lessonId:93526})).statusCode,404);assert.equal(f.calls.length,0);
});
test('all reads and writes bind bearer owner ignoring supplied userId',async()=>{
 const f=fixture();f.tables.academy_certificates.push({user_id:'other',course_id:94436,id:'secret'});f.tables.academy_enrollments.push({user_id:'other',course_id:95062});
 assert.deepEqual((await f.run('GET',{resource:'certificates',userId:'other'})).body.certificates,[]);
 const list=await f.run('GET',{resource:'enrollments',userId:'other'});assert.deepEqual(list.body.courses.map(c=>c.id),[94436]);assert.equal(JSON.stringify(list.body).includes('youtubeId'),false);
 await f.run('POST',{resource:'progress',courseId:94436,lessonId:93526,userId:'other'});assert.equal(f.tables.academy_progress.some(p=>p.user_id==='other'),false);
});
test('lessons and material metadata require enrollment, reject cross-course/draft lesson and expose no public PDF paths',async()=>{
 const f=fixture();assert.equal((await f.run('GET',{resource:'lesson',courseId:94436,lessonId:95078})).statusCode,404);
 const r=await f.run('GET',{resource:'lesson',courseId:94436,lessonId:93526});assert.equal(r.statusCode,200);assert.ok(r.body.materials[0].key);assert.equal(JSON.stringify(r.body).includes('/academy/materials/'),false);
 const coach=fixture({courseId:94439});assert.equal((await coach.run('GET',{resource:'lesson',courseId:94439})).body.materials.length,1);assert.equal((await coach.run('POST',{resource:'progress',courseId:94439,lessonId:94502})).statusCode,404);
});
test('quiz requires all own published lessons and never returns answer keys',async()=>{
 const f=fixture({complete:false});f.tables.academy_progress.push({user_id:'other',course_id:94436,lesson_id:93526,completed_at:'today'});
 assert.equal((await f.run('GET',{resource:'quiz',courseId:94436})).statusCode,409);assert.equal((await f.run('POST',{resource:'quiz',courseId:94436,quizId:94480,answers:[]})).statusCode,409);assert.equal(f.tables.academy_quiz_attempts.length,0);
 const good=fixture();const r=await good.run('GET',{resource:'quiz',courseId:94436});assert.equal(r.statusCode,200);assert.equal(JSON.stringify(r.body).includes('correctIndex'),false);
});
test('server grades failure despite forged score, pass emits authoritative certificate and retry preserves original attempt',async()=>{
 const f=fixture();const q=quizForCourse(94436);const answers=q.questions.map(q=>q.correctIndex);
 const bad=await f.run('POST',{resource:'quiz',courseId:94436,quizId:q.id,answers:answers.map((a,i)=>(a+1)%q.questions[i].options.length),score:100,passed:true,requestId});assert.equal(bad.body.attempt.passed,false);assert.equal(bad.body.attempt.score,0);assert.equal(f.tables.academy_certificates.length,0);
 const pass=await f.run('POST',{resource:'quiz',courseId:94436,quizId:q.id,answers,requestId:'33333333-3333-4333-8333-333333333333',studentName:'Forged',courseTitle:'Forged',certificateType:'forged'});assert.equal(pass.body.attempt.passed,true);assert.equal(pass.body.certificate.student_name,'Alumno Real');assert.equal(pass.body.certificate.course_title,academyCourses.find(c=>c.id===94436).title);assert.equal(pass.body.certificate.certificate_type,'fipa');
 const replay=await f.run('POST',{resource:'quiz',courseId:94436,quizId:q.id,answers,requestId});assert.equal(replay.body.attempt.passed,false);assert.equal(f.tables.academy_quiz_attempts.length,2);assert.equal(f.tables.academy_certificates.length,1);
});
test('other owners request IDs cannot be read or overwritten; database failures fail closed',async()=>{
 const f=fixture();const q=quizForCourse(94436);f.tables.academy_quiz_attempts.push({id:requestId,user_id:'other',course_id:94436,quiz_id:q.id,passed:true});
 const r=await f.run('POST',{resource:'quiz',courseId:94436,quizId:q.id,answers:q.questions.map(q=>q.correctIndex),requestId});assert.equal(r.statusCode,409);assert.equal(f.tables.academy_certificates.length,0);
 f.offline();assert.equal((await f.run('GET',{resource:'lesson',courseId:94436,lessonId:93526})).statusCode,503);
});
test('material-only courses can take their real exam, invalid answers cannot write, and missing profile never invents a name',async()=>{
 const f=fixture({courseId:94439});const q=quizForCourse(94439);
 assert.equal((await f.run('GET',{resource:'quiz',courseId:94439})).statusCode,200);
 assert.equal((await f.run('POST',{resource:'quiz',courseId:94439,quizId:q.id,answers:[],requestId})).statusCode,400);assert.equal(f.tables.academy_quiz_attempts.length,0);
 f.tables.academy_profiles=[];
 const r=await f.run('POST',{resource:'quiz',courseId:94439,quizId:q.id,answers:q.questions.map(q=>q.correctIndex),requestId,studentName:'Spoof'});assert.equal(r.statusCode,409);assert.equal(r.body.code,'STUDENT_NAME_REQUIRED');assert.equal(f.tables.academy_certificates.length,0);assert.equal(f.tables.academy_quiz_attempts[0].passed,true);
 f.tables.academy_profiles.push({id:user.id,full_name:'Nombre registrado'});
 const retry=await f.run('POST',{resource:'quiz',courseId:94439,quizId:q.id,requestId});assert.equal(retry.statusCode,200);assert.equal(retry.body.certificate.student_name,'Nombre registrado');assert.equal(retry.body.certificate.certificate_type,'padbol');assert.equal(f.tables.academy_quiz_attempts.length,1);
});
test('private materials are signed only for enrolled course-owned manifest keys with TTL 120',async()=>{
 const denied=fixture({enrolled:false});assert.equal((await denied.run('GET',{resource:'material',courseId:94436,key:'reglamento-arbitros-es'})).statusCode,403);assert.equal(denied.signings.length,0);
 const f=fixture();for(const [key,status] of [['manual-infantil-es',404],['../../reglamento-arbitros-es',400],['reglamento-arbitros-es.pdf',400],['%2fsecret',400]])assert.equal((await f.run('GET',{resource:'material',courseId:94436,key})).statusCode,status);assert.equal(f.signings.length,0);
 const r=await f.run('GET',{resource:'material',courseId:94436,key:'reglamento-arbitros-es',path:'other.pdf',expiresIn:999999});assert.equal(r.statusCode,200);assert.equal(r.body.expiresIn,120);assert.equal(r.body.url,'https://private.test/signed/example?token=fixture');assert.deepEqual(f.signings,[{bucket:'academy-materials',path:'materials/reglamento-arbitros-es.pdf',ttl:120}]);
 f.storageOffline();assert.equal((await f.run('GET',{resource:'material',courseId:94436,key:'reglamento-arbitros-es'})).statusCode,503);
});
test('quiz rejects noninteger, sparse, missing or extra answers and unknown quiz without inserting attempts',async()=>{
 const f=fixture(),q=quizForCourse(94436),valid=q.questions.map(q=>q.correctIndex);
 for(const answers of [valid.slice(1),[...valid,0],valid.map(String),valid.map((v,i)=>i===0?0.5:v),new Array(valid.length)])assert.equal((await f.run('POST',{resource:'quiz',courseId:94436,quizId:q.id,answers})).statusCode,400);
 assert.equal((await f.run('POST',{resource:'quiz',courseId:94436,quizId:1,answers:valid})).statusCode,404);assert.equal(f.tables.academy_quiz_attempts.length,0);
});
test('profile reads and saves only verified bearer identity, ignoring client account and role fields',async()=>{
 const f=fixture();f.tables.academy_profiles.push({id:'other',full_name:'Otra persona'});
 assert.deepEqual((await f.run('GET',{resource:'profile',userId:'other'})).body,{profile:{full_name:'Alumno Real'}});
 const saved=await f.run('POST',{resource:'profile',fullName:'  Nombre   Apellido  ',id:'other',userId:'other',role:'super_admin'});assert.equal(saved.statusCode,200);assert.deepEqual(saved.body,{profile:{full_name:'Nombre Apellido'}});assert.equal(f.tables.academy_profiles.find(p=>p.id==='other').full_name,'Otra persona');assert.equal(f.tables.academy_profiles[0].role,undefined);
 f.tables.academy_profiles=f.tables.academy_profiles.filter(p=>p.id!==user.id);
 assert.equal((await f.run('GET',{resource:'profile'})).body.profile.full_name,null);
 assert.equal((await f.run('POST',{resource:'profile',fullName:'Nombre Nuevo'})).body.profile.full_name,'Nombre Nuevo');
});
test('profile rejects invalid names and auth rejects unconfirmed or malformed users before database access',async()=>{
 for(const fullName of ['', 'a','x'.repeat(161),'someone@example.com','<script>', 'Nombre\u0000Apel',42]){const f=fixture();const r=await f.run('POST',{resource:'profile',fullName});assert.equal(r.statusCode,400);assert.equal(f.calls.length,0);}
 for(const auth of [{id:user.id},{id:'invalid',email_confirmed_at:'2026-01-01'}]){const f=fixture({auth});assert.equal((await f.run('GET',{resource:'profile'})).statusCode,401);assert.equal(f.calls.length,0);}
});
test('private catalog loader caches downloads and fails closed on malformed or unavailable content',async()=>{
 let downloads=0;
 const db={storage:{from(bucket){assert.equal(bucket,'academy-content');return {async download(path){assert.equal(path,'catalog/academy-v1.json');downloads++;return {data:{async text(){return JSON.stringify(syntheticCatalog);}}};}};}}};
 const [a,b]=await Promise.all([loadAcademyCatalog(db),loadAcademyCatalog(db)]);assert.equal(a,b);assert.equal(downloads,1);assert.equal((await loadAcademyCatalog(db)),a);assert.equal(downloads,1);
 const broken={storage:{from(){return {async download(){return {error:{message:'secret'}};}};}}};await assert.rejects(loadAcademyCatalog(broken),/ACADEMY_CATALOG_UNAVAILABLE/);
 const bad=structuredClone(syntheticCatalog);bad.quizzesByCourse[94436].questions[0].correctIndex=42;assert.throws(()=>validateAcademyCatalog(bad),/ACADEMY_CATALOG_UNAVAILABLE/);assert.throws(()=>validateAcademyCatalog({}),/ACADEMY_CATALOG_UNAVAILABLE/);
});
