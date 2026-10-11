import { createHash } from 'node:crypto';

export const POINTS_CONFIG_DEFAULTS = Object.freeze({
  niveles: Object.freeze({club_no_oficial:10,club_oficial:30,nacional:100,internacional:300,mundial:1000}),
  posiciones: Object.freeze({1:100,2:60,3:40,4:25,5:15,6:10,7:5,8:5,9:5,10:5}),
  tipos_custom: Object.freeze([]), niveles_labels: Object.freeze({}), niveles_hidden: Object.freeze([]),
});
const fail = (message,code='POINTS_CONFIG_INVALID',status=409) => Object.assign(new Error(message),{code,status});
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(key) && !['__proto__','constructor','prototype'].includes(key);
export const MAX_DATABASE_POINTS = 2147483647;
const numeric = (value,max=MAX_DATABASE_POINTS) => typeof value === 'number' && Number.isFinite(value) && value>=0 && value<=max;
const allowedKeys = Object.keys(POINTS_CONFIG_DEFAULTS);

/** Validate only supplied fields. Percentages apply independently to the base; their sum is not a pool. */
export function validatePointsConfigInput(input) {
  if(!isMap(input) || !Object.keys(input).length || Object.keys(input).some(key=>!allowedKeys.includes(key))) throw fail('Revisa los campos de configuración de puntos.');
  const out={};
  for(const key of Object.keys(input)) {
    const value=input[key];
    if(key==='niveles') {
      if(!isMap(value)||!Object.keys(value).length||Object.entries(value).some(([id,n])=>!safeKey(id)||!numeric(n))) throw fail('Los valores base deben ser números válidos mayores o iguales a cero.');
      out[key]={...value};
    } else if(key==='posiciones') {
      if(!isMap(value)||!Object.keys(value).length||Object.entries(value).some(([pos,n])=>!/^([1-9]|[1-9][0-9]|100)$/.test(pos)||!numeric(n,100))) throw fail('Cada posición debe tener un porcentaje entre cero y cien.');
      out[key]={...value};
    } else if(key==='tipos_custom') {
      if(!Array.isArray(value)||value.length>100) throw fail('Revisa los tipos de torneo personalizados.');
      const seen=new Set();
      out[key]=value.map(row=>{
        if(!isMap(row)||!safeKey(row.id)||Object.hasOwn(POINTS_CONFIG_DEFAULTS.niveles,row.id)||seen.has(row.id)||typeof row.nombre!=='string'||!row.nombre.trim()||row.nombre.length>120||!numeric(row.puntos)) throw fail('Cada tipo personalizado necesita identidad, nombre y puntos válidos.');
        seen.add(row.id);return {id:row.id,nombre:row.nombre.trim(),puntos:row.puntos};
      });
    } else if(key==='niveles_labels') {
      if(!isMap(value)||Object.entries(value).some(([id,label])=>!safeKey(id)||typeof label!=='string'||label.length>120||!label.trim())) throw fail('Revisa los nombres de los niveles.');
      out[key]=Object.fromEntries(Object.entries(value).map(([id,label])=>[id,label.trim()]));
    } else {
      if(!Array.isArray(value)||value.length>100||value.some(id=>!safeKey(id))||new Set(value).size!==value.length) throw fail('Revisa los niveles ocultos.');
      out[key]=[...value];
    }
  }
  return out;
}

const canonical = value => Array.isArray(value)?value.map(canonical):isMap(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function pointsPolicyFromConfig(input={},source='persisted') {
  const supplied=Object.keys(input).length?validatePointsConfigInput(input):{};
  const config={
    niveles:{...POINTS_CONFIG_DEFAULTS.niveles,...supplied.niveles},
    posiciones:{...POINTS_CONFIG_DEFAULTS.posiciones,...supplied.posiciones},
    tipos_custom:supplied.tipos_custom??[],niveles_labels:supplied.niveles_labels??{},niveles_hidden:supplied.niveles_hidden??[],
  };
  const levels={...config.niveles};
  for(const row of config.tipos_custom) levels[row.id]=row.puntos;
  const snapshot={version:1,model:'percentage_of_base',config};
  return { ...config,config,levels,positions:Object.entries(config.posiciones).map(([pos,porcentaje])=>({posicion:Number(pos),porcentaje})).sort((a,b)=>a.posicion-b.posicion),source,snapshot,digest:createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex') };
}

/** Storage failures are errors, never a fabricated default configuration. */
export async function loadPointsPolicy(db) {
  const {data,error}=await db.from('config_puntos').select('clave,valor');
  if(error) throw fail('No se pudo comprobar la configuración de puntos. Reintenta antes de cerrar.', 'POINTS_CONFIG_UNAVAILABLE',503);
  if(!Array.isArray(data)) throw fail('No se recibió la configuración de puntos.', 'POINTS_CONFIG_UNAVAILABLE',503);
  const config={},seen=new Set();
  for(const row of data) {
    if(!allowedKeys.includes(row.clave)) continue;
    if(seen.has(row.clave)) throw fail('La configuración de puntos tiene claves duplicadas.');
    seen.add(row.clave);config[row.clave]=row.valor;
  }
  return pointsPolicyFromConfig(config,seen.size?'persisted':'defaults');
}

export function buildPointsRows(policy,{torneoId,nivel,rankingRows}) {
  if(!policy?.config||!Array.isArray(rankingRows)||!Number.isSafeInteger(Number(torneoId))||Number(torneoId)<=0) throw fail('Falta la configuración comprobada para calcular puntos.');
  const checked=pointsPolicyFromConfig(policy.config,policy.source);
  const base=checked.levels[nivel];
  if(!numeric(base)) throw fail('El nivel del torneo no tiene un valor de puntos configurado.', 'POINTS_LEVEL_UNCONFIGURED');
  const seen=new Set();
  return rankingRows.map(row=>{
    const equipoId=Number(row?.equipo_id),position=Number(row?.posicion);
    if(!Number.isSafeInteger(equipoId)||equipoId<=0||seen.has(equipoId)||!Number.isSafeInteger(position)||position<1) throw fail('La clasificación final no es válida para calcular puntos.');
    seen.add(equipoId);
    // Preserve the historical tail rule for positions not explicitly configured.
    const percent=checked.config.posiciones[position]??checked.config.posiciones[10];
    const points=Math.round(base*percent/100);
    if(!Number.isSafeInteger(points)||points>MAX_DATABASE_POINTS) throw fail('El valor de puntos calculado excede el rango permitido.');
    return {...row,equipo_id:equipoId,posicion:position,torneo_id:Number(torneoId),puntos:points};
  });
}
