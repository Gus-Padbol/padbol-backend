import { requireAdminUser } from '../lib/authAccess.js';
import { requireSuperAdminUser } from '../lib/authAccess.js';

const ORDER_STATES = ['nuevo', 'confirmado', 'preparando', 'listo_retiro', 'enviado', 'entregado', 'cancelado'];
const PAYMENT_STATES = ['pendiente', 'a_confirmar', 'confirmado', 'rechazado', 'reembolsado'];
const PAYMENT_CODES = ['cash_on_pickup', 'bank_transfer', 'mercadopago', 'stripe', 'other'];
const sid = (value) => { const id = Number.parseInt(String(value || ''), 10); return Number.isFinite(id) && id > 0 ? id : null; };
const canManage = (auth, sedeId) => auth?.role?.rol === 'super_admin' || (auth?.role?.rol === 'admin_club' && Number(auth.role.sede_id) === Number(sedeId));
const authDepsFor = (deps) => ({ getAuthenticatedUser: deps.getAuthenticatedUser, fetchUserRoleRowForAuthUser: deps.fetchUserRoleRowForAuthUser, legacySuperAdminEmails: deps.legacySuperAdminEmails });

export function mountStoreAdminRoutes(app, deps) {
  const { supabaseAdmin } = deps;
  const requireShopAdmin = async (req, res) => {
    const auth = await requireAdminUser(req, res, authDepsFor(deps));
    const sedeId = sid(req.params.id);
    if (!auth || !sedeId) return null;
    if (!canManage(auth, sedeId)) { res.status(403).json({ error: 'No tenés permiso para esta tienda' }); return null; }
    return { auth, sedeId };
  };

  app.get('/api/sedes/:id/shop/admin', async (req, res) => {
    try {
      const access = await requireShopAdmin(req, res); if (!access) return;
      const { sedeId } = access;
      const [config, methods, offers, orders] = await Promise.all([
        supabaseAdmin.from('store_sede_config').select('*').eq('sede_id', sedeId).maybeSingle(),
        supabaseAdmin.from('store_sede_payment_methods').select('*').eq('sede_id', sedeId).order('nombre'),
        supabaseAdmin.from('store_sede_offers').select('*, product:store_catalog_products(id,slug,nombre,categoria,descripcion,imagen_url,activo)').eq('sede_id', sedeId).order('id'),
        supabaseAdmin.from('store_orders').select('*, items:store_order_items(*)').eq('sede_id', sedeId).order('created_at', { ascending: false }).limit(100),
      ]);
      for (const result of [config, methods, offers, orders]) if (result.error) throw result.error;
      const list = orders.data || [];
      return res.json({
        config: config.data || { sede_id: sedeId, estado: 'opening_soon', retiro_en_sede: true, entrega_local: false },
        payment_methods: methods.data || [], offers: offers.data || [], orders: list,
        metrics: { pedidos: list.length, pendientes: list.filter((o) => !['entregado', 'cancelado'].includes(o.estado)).length, entregados: list.filter((o) => o.estado === 'entregado').length, total_informativo: list.filter((o) => o.estado !== 'cancelado').reduce((sum, o) => sum + Number(o.total || 0), 0) },
      });
    } catch (error) { console.error('GET shop admin:', error.message); return res.status(500).json({ error: 'No se pudo cargar Mi Padbol Match Shop' }); }
  });

  app.patch('/api/sedes/:id/shop/offers/:offerId', async (req, res) => {
    try {
      const access = await requireShopAdmin(req, res); if (!access) return;
      const offerId = sid(req.params.offerId); if (!offerId) return res.status(400).json({ error: 'Oferta inválida' });
      const body = req.body || {}; const patch = {};
      if ('activo' in body) patch.activo = Boolean(body.activo);
      if ('stock' in body) { const stock = Number.parseInt(body.stock, 10); if (!Number.isFinite(stock) || stock < 0) return res.status(400).json({ error: 'Stock inválido' }); patch.stock = stock; }
      if ('precio' in body) { const price = Number(body.precio); if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Precio inválido' }); patch.precio = price; }
      if ('moneda' in body) patch.moneda = String(body.moneda || '').trim().toUpperCase().slice(0, 8) || 'ARS';
      patch.updated_at = new Date().toISOString();
      const { data, error } = await supabaseAdmin.from('store_sede_offers').update(patch).eq('id', offerId).eq('sede_id', access.sedeId).eq('autorizado', true).select('*, product:store_catalog_products(*)').single();
      if (error) throw error; return res.json({ offer: data });
    } catch (error) { console.error('PATCH shop offer:', error.message); return res.status(500).json({ error: 'No se pudo guardar la oferta' }); }
  });

  app.put('/api/sedes/:id/shop/payment-methods', async (req, res) => {
    try {
      const access = await requireShopAdmin(req, res); if (!access) return;
      const methods = Array.isArray(req.body?.methods) ? req.body.methods : [];
      const rows = methods.filter((m) => PAYMENT_CODES.includes(m.codigo)).map((m) => ({ sede_id: access.sedeId, codigo: m.codigo, nombre: String(m.nombre || m.codigo).trim().slice(0, 80), activo: Boolean(m.activo), instrucciones: String(m.instrucciones || '').trim().slice(0, 1000) || null, updated_at: new Date().toISOString() }));
      const { data, error } = await supabaseAdmin.from('store_sede_payment_methods').upsert(rows, { onConflict: 'sede_id,codigo' }).select('*');
      if (error) throw error; return res.json({ payment_methods: data || [] });
    } catch (error) { console.error('PUT shop payment methods:', error.message); return res.status(500).json({ error: 'No se pudieron guardar los medios de pago' }); }
  });

  app.patch('/api/sedes/:id/shop/orders/:orderId', async (req, res) => {
    try {
      const access = await requireShopAdmin(req, res); if (!access) return;
      const orderId = sid(req.params.orderId); if (!orderId) return res.status(400).json({ error: 'Pedido inválido' });
      const body = req.body || {}; const patch = { updated_at: new Date().toISOString() };
      if ('estado' in body) { if (!ORDER_STATES.includes(body.estado)) return res.status(400).json({ error: 'Estado de pedido inválido' }); patch.estado = body.estado; }
      if ('pago_estado' in body) { if (!PAYMENT_STATES.includes(body.pago_estado)) return res.status(400).json({ error: 'Estado de pago inválido' }); patch.pago_estado = body.pago_estado; }
      const { data, error } = await supabaseAdmin.from('store_orders').update(patch).eq('id', orderId).eq('sede_id', access.sedeId).select('*, items:store_order_items(*)').single();
      if (error) throw error; return res.json({ order: data });
    } catch (error) { console.error('PATCH shop order:', error.message); return res.status(500).json({ error: 'No se pudo actualizar el pedido' }); }
  });

  const requireGlobal = async (req, res) => requireSuperAdminUser(req, res, authDepsFor(deps));
  app.get('/api/admin/shop/global', async (req, res) => {
    try {
      const auth = await requireGlobal(req, res); if (!auth) return;
      const [products, sedes, centralOffers, orders] = await Promise.all([
        supabaseAdmin.from('store_catalog_products').select('*').order('nombre'),
        supabaseAdmin.from('store_sede_config').select('*, sede:sedes(id,nombre,pais,ciudad)').order('sede_id'),
        supabaseAdmin.from('store_central_offers').select('*, product:store_catalog_products(id,nombre,slug)').order('id'),
        supabaseAdmin.from('store_orders').select('id,codigo,sede_id,estado,pago_estado,total,moneda,created_at,sede:sedes(nombre)').order('created_at', { ascending: false }).limit(200),
      ]);
      for (const r of [products, sedes, centralOffers, orders]) if (r.error) throw r.error;
      const list = orders.data || [];
      return res.json({ products: products.data || [], sedes: sedes.data || [], central_offers: centralOffers.data || [], orders: list, metrics: { orders: list.length, pending: list.filter(o => !['entregado', 'cancelado'].includes(o.estado)).length, total_informativo: list.filter(o => o.estado !== 'cancelado').reduce((sum, o) => sum + Number(o.total || 0), 0) } });
    } catch (error) { console.error('GET global shop:', error.message); return res.status(500).json({ error: 'No se pudo cargar la red global de tiendas' }); }
  });

  app.post('/api/admin/shop/products', async (req, res) => {
    try {
      const auth = await requireGlobal(req, res); if (!auth) return;
      const b = req.body || {}; const nombre = String(b.nombre || '').trim(); const slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      if (!nombre || !slug) return res.status(400).json({ error: 'Nombre y slug son obligatorios' });
      const { data, error } = await supabaseAdmin.from('store_catalog_products').insert({ nombre: nombre.slice(0, 200), slug: slug.slice(0, 120), categoria: String(b.categoria || 'official_merchandise').slice(0, 80), descripcion: String(b.descripcion || '').slice(0, 2000) || null, imagen_url: String(b.imagen_url || '').slice(0, 2000) || null, activo: b.activo !== false }).select('*').single();
      if (error) throw error; return res.status(201).json({ product: data });
    } catch (error) { console.error('POST global product:', error.message); return res.status(500).json({ error: 'No se pudo crear el producto maestro' }); }
  });

  app.patch('/api/admin/shop/products/:productId', async (req, res) => {
    try {
      const auth = await requireGlobal(req, res); if (!auth) return;
      const productId = sid(req.params.productId); if (!productId) return res.status(400).json({ error: 'Producto inválido' });
      const b = req.body || {}; const patch = { updated_at: new Date().toISOString() };
      ['nombre', 'categoria', 'descripcion', 'imagen_url'].forEach(k => { if (k in b) patch[k] = String(b[k] || '').trim() || null; }); if ('activo' in b) patch.activo = Boolean(b.activo);
      const { data, error } = await supabaseAdmin.from('store_catalog_products').update(patch).eq('id', productId).select('*').single(); if (error) throw error; return res.json({ product: data });
    } catch (error) { console.error('PATCH global product:', error.message); return res.status(500).json({ error: 'No se pudo editar el producto maestro' }); }
  });
}
