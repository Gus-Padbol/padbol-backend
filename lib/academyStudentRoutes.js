import { randomUUID } from 'node:crypto';
import { loadAcademyCatalog, validateAcademyCatalog } from './academyCatalog.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const published = course => course.lessons.filter(l => l.status === 'publish');
const summary = course => ({ id:course.id, title:course.title, lang:course.lang, slug:course.slug, quizRef:course.quizRef, materialRefs:course.materialRefs, lessons:published(course).map(({id,title,order,lang})=>({id,title,order,lang})) });
async function result(query) { const {data,error}=await query; if(error) throw fail(503,'ACADEMY_UNAVAILABLE'); return data; }

export function registerAcademyStudentRoutes(app,{db,authUserFromBearer,logger=console,catalog=null}={}) {
  if(!db?.from || typeof authUserFromBearer!=='function') throw Error('ACADEMY_CONFIG_INVALID');
  const own = (table,user) => db.from(table).select('*').eq('user_id',user.id);
  async function courseFor(user,id,academyCourses) {
    const course=academyCourses.find(c=>c.id===Number(id));
    if(!course) throw fail(404,'COURSE_NOT_AVAILABLE');
    const enrollment=await result(own('academy_enrollments',user).eq('course_id',course.id).maybeSingle());
    if(!enrollment) throw fail(403,'ENROLLMENT_REQUIRED');
    return course;
  }
  async function readyQuiz(user,course,quizId,quizzesByCourse) {
    const quiz=quizzesByCourse[course.id];
    if(!quiz || quiz.id!==Number(quizId ?? course.quizRef)) throw fail(404,'QUIZ_NOT_AVAILABLE');
    const rows=await result(own('academy_progress',user).eq('course_id',course.id));
    const done=new Set((rows||[]).filter(p=>p.completed_at).map(p=>Number(p.lesson_id)));
    if(!published(course).every(l=>done.has(l.id))) throw fail(409,'LESSONS_INCOMPLETE');
    return quiz;
  }
  async function certificate(user,course) {
    const existing=await result(own('academy_certificates',user).eq('course_id',course.id).maybeSingle());
    if(existing) return existing;
    const profile=await result(db.from('academy_profiles').select('full_name').eq('id',user.id).maybeSingle());
    const studentName=String(profile?.full_name||'').trim();
    if(!studentName) throw fail(409,'STUDENT_NAME_REQUIRED');
    await result(db.from('academy_certificates').upsert({user_id:user.id,course_id:course.id,course_title:course.title,student_name:studentName,certificate_type:[94436,94383].includes(course.id)?'fipa':'padbol'},{onConflict:'user_id,course_id',ignoreDuplicates:true}));
    return result(own('academy_certificates',user).eq('course_id',course.id).maybeSingle());
  }
  const handle = method => async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      const user=await authUserFromBearer(req);
      if(!uuid.test(String(user?.id||'')) || !user?.email_confirmed_at) throw fail(401,'UNAUTHENTICATED');
      const loaded=catalog ? validateAcademyCatalog(typeof catalog==='function'?await catalog():catalog) : await loadAcademyCatalog(db);
      const {courses:academyCourses,quizzesByCourse,videos:academyVideos,materials:academyMaterials,materialAliases:academyMaterialAliases}=loaded;
      const input=method==='GET' ? req.query||{} : req.body||{};
      const resource=String(input.resource||'enrollments');
      if(resource==='profile') {
        if(method==='POST') {
          if(typeof input.fullName!=='string') throw fail(400,'INVALID_STUDENT_NAME');
          const fullName=input.fullName.trim().replace(/\s+/gu,' ');
          if(fullName.length<2 || fullName.length>160 || /[\p{Cc}\p{Cf}<>@]/u.test(fullName)) throw fail(400,'INVALID_STUDENT_NAME');
          await result(db.from('academy_profiles').upsert({id:user.id,full_name:fullName},{onConflict:'id'}));
        }
        const profile=await result(db.from('academy_profiles').select('full_name').eq('id',user.id).maybeSingle());
        return res.json({profile:{full_name:profile?.full_name||null}});
      }
      if(method==='GET' && resource==='enrollments') {
        const enrollments=await result(own('academy_enrollments',user));
        const ids=new Set((enrollments||[]).map(e=>Number(e.course_id)));
        return res.json({enrollments:(enrollments||[]).filter(e=>academyCourses.some(c=>c.id===Number(e.course_id))),courses:academyCourses.filter(c=>ids.has(c.id)).map(summary)});
      }
      if(method==='GET' && resource==='certificates') {
        let query=own('academy_certificates',user);
        if(input.courseId!=null) {await courseFor(user,input.courseId,academyCourses); query=query.eq('course_id',Number(input.courseId));}
        return res.json({certificates:await result(query)||[]});
      }
      if(!['progress','lesson','quiz','material'].includes(resource) || (method==='POST' && ['lesson','material'].includes(resource))) throw fail(400,'INVALID_RESOURCE');
      const course=await courseFor(user,input.courseId,academyCourses);
      if(resource==='material') {
        const key=String(input.key||'');
        if(!/^[a-z0-9-]{1,100}$/.test(key)) throw fail(400,'INVALID_MATERIAL_KEY');
        const allowedRefs=new Set([...course.materialRefs,...published(course).flatMap(lesson=>lesson.materialRefs)]);
        if(![...allowedRefs].some(id=>academyMaterialAliases[id]===key)) throw fail(404,'MATERIAL_NOT_AVAILABLE');
        const filename=academyMaterials[key]?.file?.split('/').pop();
        if(!filename || !/^[a-z0-9-]+\.pdf$/.test(filename)) throw fail(503,'ACADEMY_UNAVAILABLE');
        const {data,error}=await db.storage.from('academy-materials').createSignedUrl(`materials/${filename}`,120);
        if(error || !data?.signedUrl) throw fail(503,'ACADEMY_UNAVAILABLE');
        return res.json({url:data.signedUrl,expiresIn:120});
      }
      if(resource==='progress') {
        if(method==='GET') return res.json({progress:await result(own('academy_progress',user).eq('course_id',course.id))||[]});
        const lesson=published(course).find(l=>l.id===Number(input.lessonId));
        if(!lesson) throw fail(404,'LESSON_NOT_AVAILABLE');
        await result(db.from('academy_progress').upsert({user_id:user.id,course_id:course.id,lesson_id:lesson.id,completed_at:new Date().toISOString()},{onConflict:'user_id,course_id,lesson_id',ignoreDuplicates:true}));
        return res.json({progress:await result(own('academy_progress',user).eq('course_id',course.id))||[]});
      }
      if(resource==='lesson') {
        if(input.lessonId==null) return res.json({lesson:null,video:null,materials:course.materialRefs.map(id=>({id,key:academyMaterialAliases[id],title:academyMaterials[academyMaterialAliases[id]]?.title||null}))});
        const lesson=published(course).find(l=>l.id===Number(input.lessonId));
        if(!lesson) throw fail(404,'LESSON_NOT_AVAILABLE');
        const refs=[...new Set([...course.materialRefs,...lesson.materialRefs])];
        return res.json({lesson:{id:lesson.id,title:lesson.title,order:lesson.order,lang:lesson.lang,courseId:course.id},video:academyVideos[lesson.videoRef]||null,materials:refs.map(id=>({id,key:academyMaterialAliases[id],title:academyMaterials[academyMaterialAliases[id]]?.title||null}))});
      }
      const quiz=await readyQuiz(user,course,input.quizId,quizzesByCourse);
      if(method==='GET') return res.json({quiz:{id:quiz.id,course:course.id,title:quiz.title,passThresholdPct:quiz.passThresholdPct,questions:quiz.questions.map((q,index)=>({id:index,text:q.text,options:q.options}))}});
      const requestId=input.requestId||randomUUID();
      if(!uuid.test(requestId)) throw fail(400,'INVALID_REQUEST_ID');
      const existing=await result(own('academy_quiz_attempts',user).eq('id',requestId).maybeSingle());
      if(existing) {
        if(existing.course_id!==course.id || existing.quiz_id!==quiz.id) throw fail(409,'REQUEST_CONFLICT');
        return res.json({attempt:existing,certificate:existing.passed ? await certificate(user,course):null});
      }
      const answers=input.answers;
      if(!Array.isArray(answers) || answers.length!==quiz.questions.length || Array.from(answers).some((answer,i)=>!Number.isInteger(answer)||answer<0||answer>=quiz.questions[i].options.length)) throw fail(400,'INVALID_ANSWERS');
      const score=quiz.questions.reduce((n,q,i)=>n+(answers[i]===q.correctIndex?1:0),0);
      const total=quiz.questions.length;
      const passed=score*100>=quiz.passThresholdPct*total;
      const attempt={id:requestId,user_id:user.id,course_id:course.id,quiz_id:quiz.id,score,total,passed};
      const inserted=await db.from('academy_quiz_attempts').insert(attempt).select('*').single();
      if(inserted.error) {
        if(inserted.error.code!=='23505') throw fail(503,'ACADEMY_UNAVAILABLE');
        const raced=await result(own('academy_quiz_attempts',user).eq('id',requestId).maybeSingle());
        if(!raced || raced.course_id!==course.id || raced.quiz_id!==quiz.id) throw fail(409,'REQUEST_CONFLICT');
        return res.json({attempt:raced,certificate:raced.passed ? await certificate(user,course):null});
      }
      return res.json({attempt:inserted.data,certificate:passed ? await certificate(user,course):null});
    } catch(error) {
      const status=[400,401,403,404,409].includes(error?.status)?error.status:503;
      logger?.error?.('[academy-student]',{code:error?.code||'ACADEMY_UNAVAILABLE'});
      return res.status(status).json({error:status===503?'No se pudo acceder al aula.':error.code,code:error?.code||'ACADEMY_UNAVAILABLE'});
    }
  };
  app.get('/api/academy/student',handle('GET'));
  app.post('/api/academy/student',handle('POST'));
  return {registered:true};
}
