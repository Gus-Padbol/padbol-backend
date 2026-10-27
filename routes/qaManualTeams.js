const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function mountQaManualTeamsRoutes(app,{db,getAuthenticatedUser}){
 async function handle(req,res,write=false){try{
  const auth=await getAuthenticatedUser(req);if(!auth.user)return res.status(auth.status??401).json({error:'Inicia sesión.',code:'AUTH_REQUIRED'});
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Torneo inválido.'});
  const body=req.body??{};
  if(write&&(!Array.isArray(body.user_ids)||body.user_ids.length!==2||body.user_ids.some(x=>typeof x!=='string'||!UUID.test(x))||new Set(body.user_ids.map(x=>x.toLowerCase())).size!==2||!UUID.test(body.request_id??'')||typeof body.nombre!=='string'||!body.nombre.trim()||body.nombre.trim().length>80))return res.status(400).json({error:'Elige dos jugadores QA distintos y completa el nombre de la dupla.'});
  const {data,error}=await db.rpc('gestionar_dupla_qa',{p_torneo_id:id,p_actor_id:auth.user.id,p_accion:write?'crear':'listar',p_nombre:write?body.nombre.trim():'',p_jugadores:write?body.user_ids.map(x=>x.toLowerCase()):[],p_request_id:write?body.request_id:null});
  if(error){const status=error.code==='42501'?403:error.code==='P0002'?404:['23505','40001','55000'].includes(error.code)?409:error.code==='22023'?400:503;return res.status(status).json({error:status===403?'No puedes administrar este torneo.':status===409?'La inscripción cambió, ya existe o el fixture está generado. Recarga y revisa los equipos.':status===400?'Esta carga requiere un torneo QA de dobles y dos jugadores QA elegibles.':'No se pudo confirmar la operación.',code:'QA_TEAM_UNCONFIRMED'});}
  if(data?.ok!==true||Number(data.torneo_id)!==id||write&&(!['created','idempotent'].includes(data.status)||Number(data.equipo?.torneo_id)!==id||!data.equipo?.id))return res.status(503).json({error:'No se recibió confirmación del guardado.'});
  return res.status(write&&data.status==='created'?201:200).json(data);
 }catch{return res.status(503).json({error:'No se pudo confirmar la operación.'});}}
 app.get('/api/torneos/:id/inscripcion-qa',(req,res)=>handle(req,res));
 app.post('/api/torneos/:id/inscripcion-qa',(req,res)=>handle(req,res,true));
}
