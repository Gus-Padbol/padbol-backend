import { requireAuthenticatedUser } from '../lib/authAccess.js';

const FULFILLMENT = ['pickup', 'local_delivery'];
const asSedeId = (value) => {
  const id = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
};

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
      const config = configResult.data || { sede_id: sedeId, estado: 'opening_soon' };
      const offers = config.estado === 'active'
        ? (offersResult.data || []).filter((offer) => offer.product?.activo && Number(offer.precio) >= 0)
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
      const items = Array.isArray(body.items) ? body.items : [];
      if (!sedeId || !FULFILLMENT.includes(fulfillment) || items.length === 0) return res.status(400).json({ error: 'Revisá los datos del pedido' });
      const { data: config, error: configError } = await supabaseAdmin.from('store_sede_config').select('*').eq('sede_id', sedeId).maybeSingle();
      if (configError) throw configError;
      if (config?.estado !== 'active') return res.status(409).json({ error: 'La tienda no está activa' });
      if (fulfillment === 'pickup' && !config.retiro_en_sede) return res.status(409).json({ error: 'Esta sede no ofrece retiro' });
      if (fulfillment === 'local_delivery' && !config.entrega_local) return res.status(409).json({ error: 'Esta sede no ofrece entrega local' });

      const requested = items.map((item) => ({ offerId: asSedeId(item.offer_id), quantity: Number.parseInt(item.quantity, 10) })).filter((item) => item.offerId && Number.isFinite(item.quantity) && item.quantity > 0);
      if (requested.length !== items.length) return res.status(400).json({ error: 'Hay productos inválidos en el carrito' });
      const offerIds = requested.map((item) => item.offerId);
      const { data: offers, error: offersError } = await supabaseAdmin.from('store_sede_offers')
        .select('id,sede_id,product_id,activo,autorizado,autorizado_por_super,precio,moneda,stock,product:store_catalog_products(id,nombre,activo)')
        .eq('sede_id', sedeId).in('id', offerIds);
      if (offersError) throw offersError;
      if ((offers || []).length !== requested.length) return res.status(409).json({ error: 'Algún producto ya no está disponible' });
      const map = new Map((offers || []).map((offer) => [Number(offer.id), offer]));
      let total = 0; let currency = null;
      for (const item of requested) {
        const offer = map.get(item.offerId);
        if (!offer?.activo || !offer.autorizado || !offer.autorizado_por_super || !offer.product?.activo || Number(offer.stock) < item.quantity || Number(offer.precio) < 0) return res.status(409).json({ error: 'Stock o precio actualizado: revisá tu carrito' });
        if (currency && currency !== offer.moneda) return res.status(409).json({ error: 'El pedido debe usar una sola moneda' });
        currency = offer.moneda; total += Number(offer.precio) * item.quantity;
      }
      const code = `PMS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const { data: order, error: orderError } = await supabaseAdmin.from('store_orders').insert({
        codigo: code, sede_id: sedeId, user_id: user.id, fulfillment_type: fulfillment,
        moneda: currency || 'ARS', total, nota_cliente: String(body.nota_cliente || '').trim().slice(0, 1000) || null,
        estado: 'nuevo', pago_estado: 'a_confirmar',
      }).select('*').single();
      if (orderError) throw orderError;
      const orderItems = requested.map((item) => {
        const offer = map.get(item.offerId);
        return { order_id: order.id, product_id: offer.product_id, nombre_producto: offer.product.nombre, precio_unitario: offer.precio, cantidad: item.quantity };
      });
      const { error: itemsError } = await supabaseAdmin.from('store_order_items').insert(orderItems);
      if (itemsError) throw itemsError;
      // Reserve immediately. The venue can restore stock when cancelling an order.
      await Promise.all(requested.map((item) => {
        const offer = map.get(item.offerId);
        return supabaseAdmin.from('store_sede_offers').update({ stock: Number(offer.stock) - item.quantity, updated_at: new Date().toISOString() }).eq('id', offer.id).eq('stock', offer.stock);
      }));
      return res.status(201).json({ order: { ...order, items: orderItems }, message: 'Pedido recibido por la sede' });
    } catch (error) {
      console.error('POST store order:', error.message);
      return res.status(500).json({ error: 'No se pudo registrar el pedido' });
    }
  });

  app.get('/api/jugador/shop/orders', async (req, res) => {
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
      if (!user) return;
      const { data, error } = await supabaseAdmin.from('store_orders').select('*, items:store_order_items(*), sede:sedes(id,nombre,ciudad,pais)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.json({ orders: data || [] });
    } catch (error) {
      console.error('GET player shop orders:', error.message);
      return res.status(500).json({ error: 'No se pudo cargar tus pedidos' });
    }
  });
}
