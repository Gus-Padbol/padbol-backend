import https from 'node:https';
import { normalizeEmail, normalizePhone } from './crmContact.js';
import { isPadelOnly, scoreProspect } from './crmProspectScoring.js';

const OVERPASS_URLS = ['https://overpass.osm.ch/api/interpreter','https://overpass-api.de/api/interpreter','https://lz4.overpass-api.de/api/interpreter'];
const DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?([^\/\s]+)/i;

export function normalizeDomain(value) {
  const match = DOMAIN_RE.exec(String(value || '').trim());
  return match ? match[1].toLowerCase().replace(/\.$/, '') : null;
}

export function normalizeProspectName(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dedupeKeyFor(prospect = {}) {
  const domain = normalizeDomain(prospect.domain || prospect.website);
  if (domain) return `domain:${domain}`;
  const email = normalizeEmail(prospect.email);
  if (email) return `email:${email}`;
  const phone = normalizePhone(prospect.phone);
  if (phone) return `phone:${phone}`;
  return `name:${normalizeProspectName(prospect.name)}|${String(prospect.country || '').toLowerCase()}|${normalizeProspectName(prospect.city)}`;
}

function overpassQuery({ country = 'US', state, city }) {
  const areaName = city || state;
  const area = areaName ? `area["name"="${String(areaName).replace(/["\\\\]/g, '')}"]["boundary"="administrative"]->.searchArea;` : '';
  const scope = areaName ? '(area.searchArea)' : `(area["ISO3166-1"="${country}"])`;
  return `[out:json][timeout:25];${area}\n(\n  nwr${scope}["leisure"="sports_centre"];\n  nwr${scope}["leisure"="stadium"];\n  nwr${scope}["leisure"="pitch"]["sport"~"soccer|futsal|football",i];\n  nwr${scope}["sport"~"soccer|futsal|football",i];\n);\nout tags center 100;`;
}

function elementToProspect(element, query) {
  const tags = element.tags || {};
  const name = tags.name || tags.operator || tags['name:en'] || null;
  if (!name) return null;
  const website = tags.website || tags['contact:website'] || tags.url || null;
  const email = tags.email || tags['contact:email'] || null;
  const phone = tags.phone || tags['contact:phone'] || null;
  const address = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || null;
  const sector = tags.sport || tags.leisure || 'sports centre';
  const activities = [tags.sport, tags.leisure, tags.description].filter(Boolean).join(' · ');
  const prospect = {
    external_source: 'openstreetmap', external_id: `${element.type}:${element.id}`,
    name, legal_name: tags.operator || null, trade_name: name, website,
    domain: normalizeDomain(website), email: normalizeEmail(email), phone: normalizePhone(phone),
    address, city: tags['addr:city'] || query.city || null, state: tags['addr:state'] || query.state || null,
    country: 'US', latitude: element.lat ?? element.center?.lat ?? null, longitude: element.lon ?? element.center?.lon ?? null,
    sector, activities, opportunity_type: /stadium|arena/i.test(sector) ? 'venue_operator' : 'sports_operator',
    parent_company: tags.operator || null, location_type: 'independent', locations_count: 1,
    facility_notes: tags.description || null, contact_name: null, contact_role: null,
    source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    source_checked_at: new Date().toISOString(),
    data_status: {
      name: 'confirmed', website: website ? 'confirmed' : 'missing', email: email ? 'confirmed' : 'missing',
      phone: phone ? 'confirmed' : 'missing', address: address ? 'confirmed' : 'missing',
      city: tags['addr:city'] ? 'confirmed' : 'inferred', sector: 'confirmed', locations: 'inferred',
    },
    is_padel_only: isPadelOnly({sector: activities, name, website}),
  };
  const score = scoreProspect(prospect);
  return {...prospect, score: score.score, grade: score.grade, score_breakdown: score.breakdown, exclusion_reason: score.exclusion_reason};
}

function httpsPostForm(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = String(options?.body || '');
    const request = https.request({hostname:target.hostname,path:target.pathname+target.search,method:'POST',family:4,timeout:30000,headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(payload),'Accept':'application/json','User-Agent':'PadbolProspect/1.0 (commercial research; contact info@padbol.com)'}}, response => {
      let raw=''; response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let json=null; try { json=JSON.parse(raw); } catch {}
        resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>json});
      });
    });
    request.on('timeout',()=>request.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})));
    request.on('error',reject);
    request.end(payload);
  });
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {family:4,timeout:20000,headers:{'User-Agent':'PadbolProspect/1.0 (info@padbol.com)','Accept':'application/json'}}, response => {
      let raw=''; response.setEncoding('utf8'); response.on('data', chunk => { raw += chunk; });
      response.on('end', () => { let json=null; try { json=JSON.parse(raw); } catch {} resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>json}); });
    });
    request.on('timeout',()=>request.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})));
    request.on('error',reject);
  });
}

function nominatimProspect(item, query) {
  const tags=item.extratags||{};
  const address=item.address||{};
  const name=item.name||item.display_name?.split(',')[0]||null;
  if(!name)return null;
  if(/medical|clinic|orthopedic|hospital|doctor|dentist|urgent care|physiotherap|cycleway|parking|car wash|real estate|insurance/i.test(name))return null;
  if(item.class==='amenity'&&['clinic','doctors','hospital','dentist'].includes(item.type))return null;
  if(['cycleway','parking','physiotherapist','commercial','shop','office'].includes(item.type))return null;
  const subject=[name,item.type,item.class,tags.sport,tags.leisure,tags.description].filter(Boolean).join(' ');
  if(!/soccer|football|futsal|sport|athletic|stadium|arena|recreation|complex|club|indoor/i.test(subject))return null;
  const website=tags.website||tags['contact:website']||null;
  const email=tags.email||tags['contact:email']||null;
  const phone=tags.phone||tags['contact:phone']||null;
  const street=[address.house_number,address.road].filter(Boolean).join(' ')||null;
  const sector=tags.sport||item.type||item.class||'sports facility';
  const prospect={
    external_source:'openstreetmap',external_id:`${item.osm_type||'node'}:${item.osm_id}`,
    name,legal_name:tags.operator||null,trade_name:name,website,domain:normalizeDomain(website),
    email:normalizeEmail(email),phone:normalizePhone(phone),address:street||null,
    city:address.city||address.town||address.village||query.city||null,
    state:address.state||query.state||null,country:'US',
    latitude:item.lat?Number(item.lat):null,longitude:item.lon?Number(item.lon):null,
    sector,activities:[tags.sport,tags.leisure,item.type].filter(Boolean).join(' · '),
    opportunity_type:/stadium|arena/i.test(sector)?'venue_operator':'sports_operator',parent_company:tags.operator||null,
    location_type:'independent',locations_count:1,facility_notes:tags.description||null,contact_name:null,contact_role:null,
    source_url:`https://www.openstreetmap.org/${item.osm_type||'node'}/${item.osm_id}`,
    source_checked_at:new Date().toISOString(),
    data_status:{name:'confirmed',website:website?'confirmed':'missing',email:email?'confirmed':'missing',phone:phone?'confirmed':'missing',address:street?'confirmed':'missing',city:address.city?'confirmed':'inferred',sector:'confirmed',locations:'inferred'},
    is_padel_only:isPadelOnly({sector:[sector,tags.sport,tags.leisure,item.type,name].filter(Boolean).join(' '),name,website}),
  };
  const score=scoreProspect(prospect);
  return {...prospect,score:score.score,grade:score.grade,score_breakdown:score.breakdown,exclusion_reason:score.exclusion_reason};
}

const NOMINATIM_TERMS=['soccer','indoor soccer','sports center','sports complex','futsal','football club','athletic club','recreation center','indoor sports','multi-sport complex','soccer academy','stadium'];
export async function searchPublicProspects({country='US',state,city,limit=50,fetchImpl=null}={}) {
  const terms=NOMINATIM_TERMS;
  const place=[city,state,country==='US'?'United States':country].filter(Boolean).join(', ');
  const found=[]; const seen=new Set();
  for(const term of terms){
    const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(`${term} ${place}`)}&countrycodes=${encodeURIComponent((country||'US').toLowerCase())}&limit=15&addressdetails=1&extratags=1`;
    let response;
    try{response=await (fetchImpl||httpsGetJson)(url);}catch{continue;}
    if(!response?.ok)continue;
    const items=await response.json().catch(()=>[]);
    for(const item of Array.isArray(items)?items:[]){
      const prospect=nominatimProspect(item,{country,state,city}); if(!prospect)continue;
      const key=dedupeKeyFor(prospect); if(seen.has(key))continue; seen.add(key); found.push(prospect);
      if(found.length>=Math.max(1,Math.min(50,Number(limit)||50)))break;
    }
    if(found.length>=Math.max(1,Math.min(50,Number(limit)||50)))break;
    await new Promise(resolve=>setTimeout(resolve,1100));
  }
  return {prospects:found,attribution:'Datos © OpenStreetMap contributors, ODbL 1.0 · búsqueda Nominatim',source:'openstreetmap_nominatim',query:{country,state,city},cost_cents:0};
}

export async function searchOpenStreetMap({ country = 'US', state, city, limit = 50, fetchImpl = null } = {}) {
  let response=null, lastError=null;
  for(const endpoint of OVERPASS_URLS){
    try{
      const candidate=await (fetchImpl || httpsPostForm)(endpoint, {
        body:new URLSearchParams({data:overpassQuery({country,state,city})}).toString(),
      });
      if(candidate.ok){response=candidate;break;}
      lastError=Object.assign(new Error('La fuente pública no respondió.'),{status:candidate.status});
    }catch(e){lastError=e;}
  }
  if(!response) throw Object.assign(new Error('La fuente pública no respondió.'), {status: 503, code: 'PROSPECT_SOURCE_UNAVAILABLE'});
  const data = await response.json();
  const seen = new Set();
  const prospects = [];
  for (const element of data.elements || []) {
    const prospect = elementToProspect(element, {country,state,city});
    if (!prospect) continue;
    const key = dedupeKeyFor(prospect);
    if (seen.has(key)) continue;
    seen.add(key); prospects.push(prospect);
    if (prospects.length >= Math.max(1, Math.min(50, Number(limit) || 50))) break;
  }
  return {prospects, attribution: 'Datos © OpenStreetMap contributors, ODbL 1.0', source: 'openstreetmap', query: {country,state,city}, cost_cents: 0};
}
