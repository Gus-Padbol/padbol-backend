import { parseCustomerCsv, previewCustomerImport, saveCustomerImport } from './clubCustomerImport.js';

export function registerClubCustomerImportRoutes(app, { pool, enabled = false, resolveScope, allowedVenues }) {
  const path = '/api/admin/sedes/:sedeId/importaciones/clientes';
  async function authorize(req) {
    const scope = await resolveScope(req);
    if (!scope?.authUserId) throw Object.assign(new Error('Ingresá con tu cuenta.'), { status: 401 });
    if (!['super_admin', 'admin_club', 'admin_cadena', 'admin_nacional'].includes(scope.rol)) throw Object.assign(new Error('No autorizado.'), { status: 403 });
    const venueId = Number(req.params.sedeId);
    const allowed = await allowedVenues(scope);
    if (!Number.isSafeInteger(venueId) || venueId <= 0 || !(allowed?.sedes || []).some(s => Number(s.id) === venueId)) throw Object.assign(new Error('Sede no autorizada.'), { status: 403 });
    if (!enabled || !pool) throw Object.assign(new Error('Importación todavía no habilitada en este entorno.'), { status: 409 });
    return { venueId, actorId: scope.authUserId };
  }
  function input(body) {
    if (!body || body.csv != null && body.rows != null) throw Object.assign(new Error('Elegí un solo archivo.'), { status: 400 });
    return { provider: body.provider, mapping: body.mapping, rows: body.csv != null ? parseCustomerCsv(body.csv, body.delimiter) : body.rows };
  }
  const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { const scope = await authorize(req); return await fn(req, res, scope); }
    catch (error) { return res.status([400,401,403,409].includes(error.status) ? error.status : 503).json({ error: [400,401,403,409].includes(error.status) ? error.message : 'No se pudo completar la importación. No confirmes una carga sin revisar su estado.' }); }
  };
  app.post(`${path}/preview`, handle(async (req, res) => res.json(previewCustomerImport(input(req.body)))));
  app.post(`${path}/confirm`, handle(async (req, res, scope) => res.json(await saveCustomerImport({ pool, ...scope, input: input(req.body), fingerprint: req.body.fingerprint }))));
  app.get(path, handle(async (req, res, { venueId }) => {
    const result = await pool.query('SELECT id,provider,name,email,phone,created_at FROM public.club_imported_contacts WHERE sede_id=$1 ORDER BY id DESC LIMIT 100', [venueId]);
    res.json({ contacts: result.rows, limit: 100 });
  }));
}
