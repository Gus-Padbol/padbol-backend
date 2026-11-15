import sharp from 'sharp';

export const HUB_EDITOR_BUCKET = 'hub-editor-originals';
export const HUB_EDITOR_ORIGINAL_LIMIT = 10 * 1024 * 1024;
export const HUB_EDITOR_FINAL_LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9_-]{1,64}$/i;
const validKey = value => typeof value === 'string' && KEY.test(value);
export const validSourceId = (id) => typeof id === 'string' && UUID.test(id);
export function editorError(code, status = 400) { return Object.assign(new Error(code), {code, status}); }
export function parseEditorJson(value) {
  try { if (typeof value !== 'string' || value.length > 8192) throw Error(); return JSON.parse(value); }
  catch { throw editorError('INVALID_EDITOR_DATA'); }
}
export function normalizeHubTarget(raw) {
  if (!raw || !['legacy', 'inicio', 'deporte'].includes(raw.kind)) throw editorError('INVALID_HUB_TARGET');
  if (raw.kind === 'deporte') {
    if (!validKey(raw.deporte) || !validKey(raw.card_key)) throw editorError('INVALID_HUB_TARGET');
    return {kind:'deporte', deporte:raw.deporte.toLowerCase(), card_key:raw.card_key};
  }
  if (!validKey(raw.id)) throw editorError('INVALID_HUB_TARGET');
  const HUB_INICIO_CARD_IDS = ['hub_inicio_card_1','hub_inicio_card_2','hub_inicio_card_3','hub_inicio_card_4'];
  if (raw.kind === 'inicio' && !HUB_INICIO_CARD_IDS.includes(raw.id)) throw editorError('INVALID_HUB_TARGET');
  return {kind:raw.kind, id:raw.id};
}
export function normalizeHubFrame(raw) {
  const p = raw?.pixels;
  if (!p || !['x','y','width','height'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k]) && Math.abs(p[k]) <= 100000)
    || p.width <= 0 || p.height <= 0) throw editorError('INVALID_HUB_FRAME');
  const frame = {version:1, pixels:{x:p.x,y:p.y,width:p.width,height:p.height}};
  if (raw.zoom !== undefined) {
    if (!Number.isFinite(raw.zoom) || raw.zoom <= 0 || raw.zoom > 100) throw editorError('INVALID_HUB_FRAME');
    frame.zoom=raw.zoom;
  }
  for (const [name, keys] of [['position',['x','y']],['viewport',['width','height']]]) {
    if (raw[name] !== undefined) {
      if (!keys.every(k=>typeof raw[name]?.[k] === 'number' && Number.isFinite(raw[name][k]) && Math.abs(raw[name][k]) <= 100000)) throw editorError('INVALID_HUB_FRAME');
      if (name === 'viewport' && keys.some(k=>raw[name][k]<=0)) throw editorError('INVALID_HUB_FRAME');
      frame[name]=Object.fromEntries(keys.map(k=>[k,raw[name][k]]));
    }
  }
  return frame;
}
export async function inspectHubImage(file, maxBytes) {
  if (!file?.buffer?.length || file.buffer.length > maxBytes || !['image/jpeg','image/png','image/webp'].includes(file.mimetype)) throw editorError('INVALID_HUB_IMAGE');
  let info;
  try { info=await sharp(file.buffer,{limitInputPixels:40_000_000,animated:false}).metadata(); }
  catch { throw editorError('INVALID_HUB_IMAGE'); }
  const mime={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[info.format];
  if (!mime || mime !== file.mimetype || !info.width || !info.height || (info.pages ?? 1) > 1) throw editorError('INVALID_HUB_IMAGE');
  return {width:info.width,height:info.height,mime,ext:info.format === 'jpeg' ? 'jpg' : info.format};
}
export function hubTargetQuery(client, target) {
  let q=client.from(target.kind === 'deporte' ? 'hub_deporte_config' : 'hub_config').select('*');
  return target.kind === 'deporte' ? q.eq('deporte',target.deporte).eq('card_key',target.card_key) : q.eq('id',target.id);
}
export function hubRowImage(row,target) { return row?.[target.kind === 'deporte' ? 'imagen_url':'foto_url'] ?? null; }
export function sourceFromFinalUrl(url) {
  const match=String(url || '').match(/\/editor\/v1\/([0-9a-f-]+)\/final\.(?:jpg|png|webp)$/i);
  return match && validSourceId(match[1]) ? match[1] : null;
}
export async function requirePrivateHubBucket(client) {
  const {data,error}=await client.storage.getBucket(HUB_EDITOR_BUCKET);
  if (error || !data || data.public !== false) throw editorError('HUB_EDITOR_STORAGE_NOT_READY',503);
}
export async function downloadEditorManifest(client, id) {
  if (!validSourceId(id)) throw editorError('INVALID_SOURCE_ID');
  const {data,error}=await client.storage.from(HUB_EDITOR_BUCKET).download(`editor/v1/${id}/manifest.json`);
  if (error || !data) throw editorError('SOURCE_NOT_AVAILABLE',404);
  let manifest;
  try { const text=await data.text(); if(text.length>16384)throw Error(); manifest=JSON.parse(text); }
  catch { throw editorError('SOURCE_NOT_AVAILABLE',404); }
  if (manifest.source_id !== id || !['jpg','png','webp'].includes(manifest.original?.ext)) throw editorError('SOURCE_NOT_AVAILABLE',404);
  return manifest;
}
