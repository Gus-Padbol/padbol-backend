/**
 * Store order writes go through the transactional RPCs defined in
 * sql/candidates/20261123120000_store_orders_schema.sql. They run with the
 * existing Supabase service-role client (supabase-js `.rpc`), so the store flow
 * does not require a new pgPool, DATABASE_URL or extra credentials.
 *
 * Idempotency is explicit and scoped to (verified buyer, sede, client key):
 * - same key + same cart -> the existing order is returned (replayed=true)
 * - same key + another cart -> STORE_IDEMPOTENCY_MISMATCH (409)
 * - old clients without a key keep the previous contract, with no false promise
 *
 * The buyer identity is always the user resolved by the server from the session;
 * a user_id in the request body is never used.
 */
export class StoreOrderError extends Error {
  constructor(message, status = 409, code = 'STORE_CONFLICT') {
    super(message);
    this.name = 'StoreOrderError';
    this.status = status;
    this.code = code;
  }
}

const FULFILLMENT = ['pickup', 'local_delivery'];
const MAX_ITEMS = 50;
const MAX_KEY_LENGTH = 200;
const MAX_QUANTITY = 2147483647;

const RPC_ERRORS = Object.freeze({
  STORE_AUTH_REQUIRED: [401, 'No autorizado'],
  STORE_INVALID_SEDE: [400, 'Revisá los datos del pedido'],
  STORE_INVALID_FULFILLMENT: [400, 'Revisá los datos del pedido'],
  STORE_INVALID_ITEMS: [400, 'Hay productos inválidos en el carrito'],
  STORE_IDEMPOTENCY_KEY_INVALID: [400, 'La clave de intento no es válida'],
  STORE_INVALID_STATE: [400, 'Estado de pedido inválido'],
  STORE_ORDER_NOT_FOUND: [404, 'Pedido no encontrado en esta sede'],
  STORE_IDEMPOTENCY_MISMATCH: [409, 'La clave de intento ya se usó con otro carrito'],
  STORE_NOT_ACTIVE: [409, 'La tienda no está activa'],
  STORE_PICKUP_UNAVAILABLE: [409, 'Esta sede no ofrece retiro'],
  STORE_DELIVERY_UNAVAILABLE: [409, 'Esta sede no ofrece entrega local'],
  STORE_OFFER_UNAVAILABLE: [409, 'Algún producto ya no está disponible'],
  STORE_PRICE_UNAVAILABLE: [409, 'El precio del producto no está disponible'],
  STORE_CURRENCY_MISMATCH: [409, 'El pedido debe usar una sola moneda'],
  STORE_STOCK_UNAVAILABLE: [409, 'Stock o precio actualizado: revisá tu carrito'],
  STORE_STOCK_CHANGED: [409, 'Stock o precio actualizado: revisá tu carrito'],
  STORE_UNAVAILABLE: [503, 'La tienda no está disponible en este momento'],
});

const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export function normalizeIdempotencyKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  if (!key) return null;
  if (key.length > MAX_KEY_LENGTH) {
    throw new StoreOrderError('La clave de intento no es válida', 400, 'STORE_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    throw new StoreOrderError('Revisá los datos del pedido', 400, 'STORE_INVALID_ITEMS');
  }
  const seen = new Set();
  return items.map((item) => {
    const offerId = positiveInteger(item?.offer_id);
    const quantity = positiveInteger(item?.quantity);
    if (!offerId || !quantity || quantity > MAX_QUANTITY) {
      throw new StoreOrderError('Hay productos inválidos en el carrito', 400, 'STORE_INVALID_ITEMS');
    }
    if (seen.has(offerId)) {
      throw new StoreOrderError('Hay productos repetidos en el carrito', 400, 'STORE_INVALID_ITEMS');
    }
    seen.add(offerId);
    return { offer_id: offerId, quantity };
  });
}

function mapRpcError(error) {
  const raw = String(error?.message ?? error?.details ?? '').trim();
  const token = (raw.match(/STORE_[A-Z_]+/) || [])[0];
  if (token && RPC_ERRORS[token]) {
    const [status, message] = RPC_ERRORS[token];
    return new StoreOrderError(message, status, token);
  }
  if (error?.code === '23505' && /idempotency/i.test(`${error?.constraint || ''} ${error?.details || ''}`)) {
    return new StoreOrderError(RPC_ERRORS.STORE_IDEMPOTENCY_MISMATCH[1], 409, 'STORE_IDEMPOTENCY_MISMATCH');
  }
  if (error?.code === '23514' && /stock/i.test(String(error?.constraint || ''))) {
    return new StoreOrderError(RPC_ERRORS.STORE_STOCK_CHANGED[1], 409, 'STORE_STOCK_CHANGED');
  }
  if (['PGRST202', '42883', '42501'].includes(String(error?.code || ''))
      || /function .* does not exist|permission denied/i.test(raw)) {
    return new StoreOrderError(RPC_ERRORS.STORE_UNAVAILABLE[1], 503, 'STORE_UNAVAILABLE');
  }
  return null;
}

function unwrapRpcPayload(data) {
  const order = data?.order;
  if (!order || typeof order !== 'object') {
    throw new StoreOrderError('No se pudo registrar el pedido', 500, 'STORE_RESPONSE_INVALID');
  }
  return {
    order: { ...order, items: Array.isArray(data.items) ? data.items : [] },
    replayed: Boolean(data.replayed),
  };
}

async function callRpc(db, name, params, fallbackMessage) {
  if (!db || typeof db.rpc !== 'function') {
    throw new StoreOrderError(RPC_ERRORS.STORE_UNAVAILABLE[1], 503, 'STORE_UNAVAILABLE');
  }
  const { data, error } = await db.rpc(name, params);
  if (error) {
    throw mapRpcError(error) || new StoreOrderError(fallbackMessage, 500, 'STORE_INTERNAL');
  }
  return data;
}

export async function createStoreOrder(db, {
  sedeId,
  userId,
  fulfillment,
  items,
  notaCliente = null,
  idempotencyKey = null,
}) {
  if (!userId) throw new StoreOrderError('No autorizado', 401, 'STORE_AUTH_REQUIRED');
  const venueId = positiveInteger(sedeId);
  if (!venueId) throw new StoreOrderError('Revisá los datos del pedido', 400, 'STORE_INVALID_SEDE');
  if (!FULFILLMENT.includes(fulfillment)) {
    throw new StoreOrderError('Revisá los datos del pedido', 400, 'STORE_INVALID_FULFILLMENT');
  }
  const requested = normalizeItems(items);
  const key = normalizeIdempotencyKey(idempotencyKey);

  const data = await callRpc(db, 'store_create_order', {
    p_user_id: userId,
    p_sede_id: venueId,
    p_fulfillment_type: fulfillment,
    p_items: requested,
    p_nota_cliente: notaCliente,
    p_idempotency_key: key,
  }, 'No se pudo registrar el pedido');
  return unwrapRpcPayload(data);
}

export async function updateStoreOrder(db, { sedeId, orderId, estado, pagoEstado }) {
  const venueId = positiveInteger(sedeId);
  const id = positiveInteger(orderId);
  if (!venueId || !id) throw new StoreOrderError('Pedido no encontrado en esta sede', 404, 'STORE_ORDER_NOT_FOUND');

  const data = await callRpc(db, 'store_update_order', {
    p_order_id: id,
    p_sede_id: venueId,
    p_estado: estado ?? null,
    p_pago_estado: pagoEstado ?? null,
  }, 'No se pudo actualizar el pedido');
  return unwrapRpcPayload(data);
}
