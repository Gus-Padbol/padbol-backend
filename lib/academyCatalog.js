const cache=new WeakMap();
const invalid=()=>Object.assign(new Error('ACADEMY_CATALOG_UNAVAILABLE'),{status:503,code:'ACADEMY_CATALOG_UNAVAILABLE'});
export function validateAcademyCatalog(value) {
  if(!value || !Array.isArray(value.courses) || !value.courses.length || !value.quizzesByCourse || !value.videos || !value.materials || !value.materialAliases) throw invalid();
  const ids=new Set();
  for(const course of value.courses) {
    if(!Number.isInteger(course.id)||ids.has(course.id)||typeof course.title!=='string'||!Array.isArray(course.lessons)||!Array.isArray(course.materialRefs)) throw invalid();
    ids.add(course.id);
    for(const lesson of course.lessons) if(!Number.isInteger(lesson.id)||!Array.isArray(lesson.materialRefs)||!['publish','draft'].includes(lesson.status)) throw invalid();
    const quiz=value.quizzesByCourse[course.id];
    if(course.quizRef!=null && (!quiz || quiz.id!==course.quizRef || quiz.course!==course.id)) throw invalid();
    if(quiz && (!Array.isArray(quiz.questions)||!quiz.questions.length||!Number.isFinite(quiz.passThresholdPct)||quiz.passThresholdPct<1||quiz.passThresholdPct>100)) throw invalid();
    for(const q of quiz?.questions||[]) if(typeof q.text!=='string'||!Array.isArray(q.options)||q.options.length<2||q.options.some(v=>typeof v!=='string')||!Number.isInteger(q.correctIndex)||q.correctIndex<0||q.correctIndex>=q.options.length) throw invalid();
  }
  return value;
}
// Catalog contains protected lesson media and answer keys; never bundle it in this repository.
export async function loadAcademyCatalog(db) {
  const entry=cache.get(db);
  if(entry && entry.expires>Date.now()) return entry.promise;
  const next={expires:Date.now()+300000,promise:null};
  next.promise=(async()=>{
    try {
      const {data,error}=await db.storage.from('academy-content').download('catalog/academy-v1.json');
      if(error||!data) throw invalid();
      return validateAcademyCatalog(JSON.parse(await data.text()));
    } catch {if(cache.get(db)===next)cache.delete(db);throw invalid();}
  })();
  cache.set(db,next);
  return next.promise;
}
