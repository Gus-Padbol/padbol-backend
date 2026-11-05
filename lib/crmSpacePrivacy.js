import sharp from 'sharp';

export const SPACE_MEDIA_RETENTION_DAYS = 90;
export const SPACE_MEDIA_BUCKET = 'crm-space-requests';
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

function privacyError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

/** Only decoded/re-encoded pixels are stored. Never fall back to an original photo. */
export async function sanitizeSpaceFile(file, { kind = 'photo', imageProcessor = sharp } = {}) {
  if (kind === 'plan' && file.mimetype === 'application/pdf') {
    return { buffer: file.buffer, mimetype: 'application/pdf', extension: 'pdf', metadataStripped: false };
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.mimetype)) {
    throw privacyError('SPACE_INVALID_PHOTO', 'Las fotografías deben ser JPG, PNG, WEBP o HEIC.');
  }
  const heic = ['image/heic', 'image/heif'].includes(file.mimetype);
  try {
    const image = imageProcessor(file.buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false });
    const input = await image.metadata();
    if ((input.pages || 1) > 1) throw privacyError('SPACE_ANIMATED_IMAGE_UNSUPPORTED', 'Convierte la imagen animada a una fotografía JPG o PNG.');
    const extension = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    // No withMetadata/keepMetadata/keepExif: sharp strips metadata by default.
    let output = image.rotate().toColourspace('srgb');
    output = extension === 'png' ? output.png() : extension === 'webp' ? output.webp({ quality: 95 }) : output.jpeg({ quality: 95 });
    const buffer = await output.toBuffer();
    if (buffer.length > MAX_FILE_BYTES) throw privacyError('SPACE_SANITIZED_FILE_TOO_LARGE', 'La imagen procesada supera 12 MB. Reduce su tamaño y vuelve a intentarlo.');
    const metadata = await imageProcessor(buffer).metadata();
    if (['exif', 'iptc', 'xmp', 'icc'].some(key => metadata[key]?.length)) throw privacyError('SPACE_METADATA_STRIP_FAILED', 'No pudimos retirar los metadatos de la imagen. Convierte el archivo a JPG o PNG.');
    return { buffer, mimetype: `image/${extension === 'jpg' ? 'jpeg' : extension}`, extension, metadataStripped: true };
  } catch (error) {
    if (error?.code?.startsWith('SPACE_')) throw error;
    if (heic) throw privacyError('SPACE_HEIC_CONVERSION_REQUIRED', 'No se pudo procesar este HEIC/HEIF de forma privada. Convierte la imagen a JPG o PNG antes de enviarla; el original no se almacenó.');
    throw privacyError('SPACE_IMAGE_PROCESSING_FAILED', 'No se pudo procesar la imagen de forma privada. Usa un JPG o PNG válido de hasta 40 megapíxeles; el original no se almacenó.');
  }
}

export function spaceMediaPaths(row) {
  const files = Array.isArray(row.files) ? row.files : [];
  const paths = [...files.map(file => file.path), row.simulation_path].filter(Boolean);
  const prefix = `${row.conversation_id}/`;
  if (paths.some(path => typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..') || path.includes('\\') || path.length > 1000)) {
    throw new Error('SPACE_RETENTION_INVALID_PATH');
  }
  return [...new Set(paths)];
}

const due = `retention_expires_at <= $1 and project_active_hold = false and media_deleted_at is null`;

/** Read-only by default. Destructive mode needs both apply=true and explicit allowDelete=true. */
export async function cleanupExpiredSpaceMedia({ pool, storage = null, now = new Date(), limit = 100, apply = false, allowDelete = false } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('SPACE_RETENTION_INVALID_TIME');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('SPACE_RETENTION_INVALID_LIMIT');
  if (apply && !allowDelete) throw new Error('SPACE_RETENTION_DELETE_NOT_ENABLED');
  const select = `select id, conversation_id, files, simulation_path from public.crm_space_requests where ${due} order by retention_expires_at, id limit $2`;
  if (!apply) {
    const { rows } = await pool.query(select, [now.toISOString(), limit]);
    return { dryRun: true, requests: rows.map(row => ({ id: row.id, files: spaceMediaPaths(row).length })) };
  }
  if (!storage?.from || !pool?.connect) throw new Error('SPACE_RETENTION_DEPENDENCIES_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`${select} for update skip locked`, [now.toISOString(), limit]);
    const requests = [];
    for (const row of rows) {
      const paths = spaceMediaPaths(row);
      if (paths.length) {
        const { error } = await storage.from(SPACE_MEDIA_BUCKET).remove(paths);
        if (error) throw new Error('SPACE_RETENTION_STORAGE_DELETE_FAILED', { cause: error });
      }
      await client.query(`update public.crm_space_requests set files='[]'::jsonb, simulation_path=null, media_deleted_at=$2, updated_at=$2 where id=$1 and project_active_hold=false`, [row.id, now.toISOString()]);
      requests.push({ id: row.id, files: paths.length });
    }
    await client.query('commit');
    return { dryRun: false, requests };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

// Shared with the candidate SQL migration; no application of this SQL during tests outside PGlite.
export const SPACE_RETENTION_SCHEMA_SQL = `
  alter table public.crm_space_requests add column if not exists retention_expires_at timestamptz;
  update public.crm_space_requests set retention_expires_at=created_at + interval '90 days' where retention_expires_at is null;
  alter table public.crm_space_requests alter column retention_expires_at set default (now() + interval '90 days');
  alter table public.crm_space_requests alter column retention_expires_at set not null;
  alter table public.crm_space_requests add column if not exists project_active_hold boolean not null default false;
  alter table public.crm_space_requests add column if not exists project_hold_reason text;
  alter table public.crm_space_requests add column if not exists project_hold_set_by text;
  alter table public.crm_space_requests add column if not exists project_hold_set_at timestamptz;
  alter table public.crm_space_requests add column if not exists media_deleted_at timestamptz;
  alter table public.crm_space_requests add column if not exists metadata_policy text not null default 'legacy_unprocessed';
  do $privacy$
  begin
    if not exists (select 1 from pg_constraint where conname='crm_space_requests_active_hold_reason' and conrelid='public.crm_space_requests'::regclass) then
      alter table public.crm_space_requests add constraint crm_space_requests_active_hold_reason check (
        project_active_hold=false or (nullif(trim(project_hold_reason),'') is not null and nullif(trim(project_hold_set_by),'') is not null and project_hold_set_at is not null and media_deleted_at is null)
      );
    end if;
  end $privacy$;
  create index if not exists crm_space_requests_retention_idx on public.crm_space_requests(retention_expires_at) where project_active_hold=false and media_deleted_at is null;
  alter table public.crm_space_requests enable row level security;
  revoke all on public.crm_space_requests from public, anon, authenticated;
  grant select, insert, update on public.crm_space_requests to service_role;
`;
