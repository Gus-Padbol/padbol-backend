export const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg','image/jpg','image/png','image/webp'];
export function normalizeProfilePhotoMime(mime) { return String(mime || 'image/jpeg').toLowerCase(); }
export function decodeProfilePhoto({foto_base64, mime_type}) {
  if (!foto_base64) return {error: {status:400, code:'FOTO_REQUIRED', error:'foto_base64 es requerido'}};
  const mime = normalizeProfilePhotoMime(mime_type);
  if (!ALLOWED.includes(mime)) return {error: {status:400, code:'MIME_UNSUPPORTED', error:'mime_type de imagen no soportado'}};
  const buffer = Buffer.from(String(foto_base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (!buffer.length) return {error: {status:400, code:'IMAGE_INVALID', error:'Imagen inválida'}};
  if (buffer.length > MAX_PROFILE_PHOTO_BYTES) return {error: {status:400, code:'PHOTO_TOO_LARGE', error:'La imagen supera el tamaño máximo permitido (5 MB)'}};
  return {mime, buffer};
}
