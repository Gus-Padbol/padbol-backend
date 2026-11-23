import { requireAuthenticatedUser } from '../lib/authAccess.js';
import { createStoreOrder, StoreOrderError } from '../lib/storeOrders.js';

const FULFILLMENT = ['pickup', 'local_delivery'];
const asSedeId = (value) => {
  const id = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const hasSellablePrice = (offer) => offer?.precio != null
  && Number.isFinite(Number(offer.precio))
  && Number(offer.precio) >= 0
  && String(offer.moneda || '').trim().length > 0;

/** Public catalogue plus authenticated buyer order flow.  Payment remains manual: a
 * venue confirms it after receiving the order. */
export function mountStorePublicRoutes(app, { supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/sedes/:id/shop', async (req, res) => {
    try {
      const sedeId = asSedeId(req.params.id);
      if (!sedeId) return res.status(400).json({ error: 'Sede inválida' });
      const [configResult, offersResult, methodsResult] = await Promise.all([
        supabaseAdmin.from('store_sede_config').select('*').eq('sede_id', sedeId).maybeSingle(),
        supabaseAdmin.from('store_sede_offers')
          .select('id,sede_id,product_id,activo,autorizado,autorizado_por_super,precio,moneda,stock,product:store_catalog_products(id,slug,nombre,categoria,descripcion,imagen_url,activo)')
          .eq('sede_id', sedeId).eq('autorizado', true).eq('autorizado_por_super', true).eq('activo', true).gt('stock', 0),
        supabaseAdmin.from('store_sede_payment_methods').select('id,codigo,nombre,instrucciones').eq('sede_id', sedeId).eq('activo', true).order('nombre'),
      ]);
      for (const result of [configResult, offersResult, methodsResult]) if (result.error) throw result.error;
      const rawConfig = configResult.data;
      // Public storefront fields only; the admin config route stays separate and
      // authenticated. No admin-only field is added to this projection.
      const config = rawConfig ? {
        sede_id: rawConfig.sede_id,
        estado: rawConfig.estado,
        retiro_en_sede: rawConfig.retiro_en_sede,
        entrega_local: rawConfig.entrega_local,
        radio_entrega_km: rawConfig.radio_entrega_km,
        instrucciones_retiro: rawConfig.instrucciones_retiro,
        instrucciones_entrega: rawConfig.instrucciones_entrega,
      } : { sede_id: sedeId, estado: 'opening_soon' };
      const offers = config.estado === 'active'
        ? (offersResult.data || []).filter((offer) => offer.product?.activo && hasSellablePrice(offer))
        : [];
      return res.json({ config, offers, payment_methods: methodsResult.data || [] });
    } catch (error) {
      console.error('GET public shop:', error.message);
      return res.status(500).json({ error: 'No se pudo cargar la tienda' });
    }
  });

  app.post('/api/shop/orders', async (req, res) => {
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
      if (!user) return;
      const body = req.body || {};
      const sedeId = asSedeId(body.sede_id);
      const fulfillment = String(body.fulfillment_type || 'pickup');
      if (!sedeId || !FULFILLMENT.includes(fulfillment)) return res.status(400).json({ error: 'Revisá los datos del pedido' });

      // The standard Idempotency-Key header is preferred; idempotency_key in the
      // body is accepted for older clients. The key is never used as identity.
      const headerKey = typeof req.get === 'function' ? req.get('idempotency-key') : req.headers?.['idempotency-key'];
      const rawKey = headerKey != null && String(headerKey).trim() !== '' ? headerKey : body.idempotency_key;

      // Prices, stock, buyer identity and the order total are resolved by the
      // server-side RPC. Anything price-like or user_id-like in the body is ignored.
      const result = await createStoreOrder(supabaseAdmin, {
        sedeId,
        userId: user.id,
        fulfillment,
        items: body.items,
        notaCliente: String(body.nota_cliente || '').trim().slice(0, 1000) || null,
        idempotencyKey: rawKey,
      });
      if (result.replayed) res.set('Idempotency-Replayed', 'true');
      return res.status(201).json({ order: result.order, message: 'Pedido recibido por la sede' });
    } catch (error) {
      const status = error instanceof StoreOrderError ? error.status : 500;
      if (status >= 500) console.error('POST store order:', error.message);
      const message = error instanceof StoreOrderError ? error.message : 'No se pudo registrar el pedido';
      return res.status(status).json({ error: message });
    }
  });

  app.get('/api/jugador/shop/orders', async (req, res) => {
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
      if (!user) return;
      const { data, error } = await supabaseAdmin.from('store_orders')
        .select('id,codigo,sede_id,estado,pago_estado,fulfillment_type,moneda,total,nota_cliente,created_at,updated_at,items:store_order_items(*),sede:sedes(id,nombre,ciudad,pais)')
        .eq('user_id', user.id).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.json({ orders: data || [] });
    } catch (error) {
      console.error('GET player shop orders:', error.message);
      return res.status(500).json({ error: 'No se pudo cargar tus pedidos' });
    }
  });
}
