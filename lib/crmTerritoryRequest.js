import {createHash} from 'node:crypto';

const limits={country:80,region:120,city:120,details:1000};
const clean=(value,max)=>value.replace(/<[^>]*>/g,' ').replace(/[<>\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const invalid=()=>Object.assign(Error('Revisa los datos de la consulta territorial.'),{status:400,code:'INVALID_TERRITORY_REQUEST'});

// Request purpose is independent from the requested contact channel. Only the
// explicit territory contract is retained; financial/private/unknown keys drop.
export function createTerritoryRequest(value,{now=()=>new Date().toISOString()}={}) {
  if(value != null && (typeof value!=='object' || Array.isArray(value)))throw invalid();
  const territory={};
  if(value?.scope != null && value.scope!=='') {
    if(typeof value.scope!=='string' || !['city','region','country'].includes(value.scope.trim().toLowerCase()))throw invalid();
    territory.scope=value.scope.trim().toLowerCase();
  }
  for(const [key,max] of Object.entries(limits)) if(value?.[key] != null) {
    if(typeof value[key]!=='string')throw invalid();
    const text=clean(value[key],max);if(text)territory[key]=text;
  }
  const territoryRequest=Object.keys(territory).length ? territory : null;
  const fingerprint=createHash('sha256').update(JSON.stringify({requestPurpose:'territory',territoryRequest})).digest('hex');
  return {version:1,requestPurpose:'territory',...(territoryRequest?{territoryRequest}:{}),fingerprint,savedAt:now()};
}

export function territoryRequestSummary(request,locale='es') {
  const value=request.territoryRequest || {};
  const place=[value.city,value.region,value.country].filter(Boolean).join(', ');
  const scope=value.scope ? (locale==='en'?{city:'city',region:'region',country:'country'}:{city:'ciudad',region:'región',country:'país'})[value.scope] : '';
  return (scope ? `${locale==='en'?' Scope':' Alcance'}: ${scope}.` : '')
    +(place ? `${locale==='en'?' Territory':' Territorio'}: ${place}.` : '')
    +(value.details ? `${locale==='en'?' Request details':' Detalle de la consulta'}: ${value.details}.` : '');
}
